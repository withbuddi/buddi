import Darwin
import Foundation

/// The supervisor's control socket (`<data>/supervisor.sock`): plain HTTP/1.1
/// over a Unix socket, the same surface `buddi service status` and Settings →
/// System use. URLSession cannot address a Unix socket, so this is one request
/// per connection, `Connection: close`, read to EOF. The socket file's
/// permissions are the whole credential, as for the CLI.
enum ControlSocket {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    /// What `/status` answers (`SupervisorStatus` in packages/install/src/supervisor.ts).
    struct Status: Decodable, Sendable, Equatable {
        let phase: String?
        let supervisorPid: Int
        let installRoot: String
        let nodePath: String
        let database: String
        let gateway: String
        let gatewayPid: Int?
        let current: String?
        let upgrading: Bool?
        /// "Port 4317 was taken by another program; buddi now listens on 4391.", for a day after a move.
        let portNotice: String?
    }

    /// What `/version` and `/version/check` answer (`VersionView` in upgrade.ts).
    struct Version: Decodable, Sendable {
        let current: String
        let latest: String?
        let latestNotes: String?
        let checkedAt: String?
        let updateAvailable: Bool
        let error: String?
    }

    static func status(_ socket: String) -> Status? {
        guard let (code, body) = try? request(socket, method: "GET", path: "/status", timeout: 3), code == 200 else { return nil }
        return try? JSONDecoder().decode(Status.self, from: body)
    }

    static func version(_ socket: String, check: Bool) -> Version? {
        guard let (code, body) = try? request(socket, method: check ? "POST" : "GET",
                                              path: check ? "/version/check" : "/version",
                                              timeout: check ? 30 : 5),
              code == 200 else { return nil }
        return try? JSONDecoder().decode(Version.self, from: body)
    }

    /// One request. 200 and 202 are both answers (see `ask` in launcher.ts).
    static func request(_ socket: String, method: String, path: String, body: Data? = nil,
                        timeout: TimeInterval = 5) throws -> (Int, Data) {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure(description: "socket: \(String(cString: strerror(errno)))") }
        defer { close(fd) }

        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1_000_000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socket.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            throw Failure(description: "socket path too long: \(socket)")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { throw Failure(description: "connect: \(String(cString: strerror(errno)))") }

        var head = "\(method) \(path) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
        if let body {
            head += "Content-Type: application/json\r\nContent-Length: \(body.count)\r\n"
        } else if method != "GET" {
            head += "Content-Length: 0\r\n"
        }
        head += "\r\n"
        var out = Data(head.utf8)
        if let body { out.append(body) }
        try out.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let n = write(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                guard n > 0 else { throw Failure(description: "write: \(String(cString: strerror(errno)))") }
                sent += n
            }
        }

        var response = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let n = read(fd, &buffer, buffer.count)
            if n > 0 { response.append(buffer, count: n) } else if n == 0 { break } else {
                throw Failure(description: "read: \(String(cString: strerror(errno)))")
            }
        }

        guard let split = response.range(of: Data("\r\n\r\n".utf8)),
              let headText = String(data: response[..<split.lowerBound], encoding: .utf8) else {
            throw Failure(description: "the supervisor's answer is not HTTP")
        }
        let statusLine = headText.split(separator: "\r\n").first ?? ""
        let parts = statusLine.split(separator: " ")
        guard parts.count >= 2, let code = Int(parts[1]) else { throw Failure(description: "bad status line: \(statusLine)") }
        var payload = Data(response[split.upperBound...])
        if headText.lowercased().contains("transfer-encoding: chunked") { payload = dechunk(payload) }
        return (code, payload)
    }

    private static func dechunk(_ data: Data) -> Data {
        var out = Data()
        var rest = data[...]
        while let lineEnd = rest.range(of: Data("\r\n".utf8)),
              let sizeText = String(data: rest[..<lineEnd.lowerBound], encoding: .ascii),
              let size = Int(sizeText.split(separator: ";").first ?? "", radix: 16), size > 0 {
            let start = lineEnd.upperBound
            guard rest.distance(from: start, to: rest.endIndex) >= size else { break }
            let end = rest.index(start, offsetBy: size)
            out.append(rest[start..<end])
            rest = rest[rest.index(end, offsetBy: min(2, rest.distance(from: end, to: rest.endIndex)))...]
        }
        return out
    }
}

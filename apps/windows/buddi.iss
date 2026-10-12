; buddi for Windows: buddi-<version>-windows-x64-setup.exe (Inno Setup 6).
;
; One download a person double-clicks: no administrator, no Node, no terminal.
; It carries the bundle scripts/release/windows-bundle.sh builds (Node with npm,
; the Visual C++ runtime Postgres needs, the npm release with its embedded
; Postgres) and hands it to the release's own program,
; packages/install/src/windows-setup.ts, which does what scripts/install.sh
; does on Linux: a backup of existing data first, the releases lock, the
; switch of `current` (a junction), the start, and the way back if the new
; release does not start. Everything is per user:
;
;   %LOCALAPPDATA%\Programs\buddi\       this setup's files: buddi-desktop.exe (the app: buddi in
;                                        a window, with a tray icon; apps/desktop), bin\buddi.cmd
;                                        (on the user PATH), buddi.ico, unins000.exe (Settings → Apps)
;   %LOCALAPPDATA%\buddi\                the data directory, as every buddi on Windows has it,
;                                        with node\ and releases\ in it (or BUDDI_DATA_DIR)
;   Start menu → buddi                   opens the app's window (AppUserModelID com.withbuddi.desktop,
;                                        which its toasts are shown under)
;   HKCU\…\Run → buddi                   the app in the tray at sign-in: written by the app itself
;                                        (Start at Login, on at its first start), recorded in
;                                        HKCU\Software\buddi\Desktop; removed here only when it is that one
;   Task Scheduler → com.buddi.install.<id>   starts buddi at sign-in (written by buddi itself)
;
; Running a newer setup over an installed one upgrades it (a backup first); a
; running app is asked to quit first (buddi-desktop.exe --quit) and started again.
; The app needs WebView2: part of Windows 11; on Windows 10 without it, the
; Evergreen bootstrapper carried here installs it for this user.
; Uninstalling from Settings → Apps runs `buddi uninstall`: one last backup,
; kept in %USERPROFILE%\buddi-backups with its passphrase, then the task, the
; data and the secrets, then this setup's files and the PATH entry.
;
; Command line (all optional):
;   /VERYSILENT /SUPPRESSMSGBOXES   no wizard (Inno Setup's own switches)
;   /NOSTART                        install, but leave buddi stopped (also BUDDI_NO_START=1)
;   /SKIPBACKUP                     go on without the backup of existing data (not advised)
;   /ALLOWADMIN                     run elevated anyway (CI with /NOSTART: Postgres refuses to start
;                                   with administrator rights, so an elevated setup is refused by default)
;
; Built by the release workflow (and windows.yml for a branch):
;   iscc /DAppVersion=0.1.0-pre.54 /DVersionInfo=0.1.0.54 /DBundleZip=<zip> /DDesktopExe=<buddi-desktop.exe>
;        [/DWebView2Setup=<MicrosoftEdgeWebview2Setup.exe>] /DOutputDir=<dir> apps\windows\buddi.iss
; (scripts/release/windows-desktop.sh builds the app and fetches the bootstrapper.)
;
; Signing: unsigned for now (SmartScreen warns once per download). To sign,
; define a sign tool on the iscc line and pass its name here, for example
;   iscc "/Sbuddisign=signtool.exe sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /f cert.pfx /p {pw} $f" /DSignTool=buddisign …
; and the setup, its uninstaller and the app (buddi-desktop.exe, `signonce`) are
; all signed by that one hook. The WebView2 bootstrapper is Microsoft's, signed by them.

#ifndef AppVersion
  #error Pass /DAppVersion=<buddi version>
#endif
#ifndef VersionInfo
  #error Pass /DVersionInfo=<four numbers> (scripts/release/bundle-version.mjs)
#endif
#ifndef BundleZip
  #error Pass /DBundleZip=<buddi-version-windows-x64.zip>
#endif
#ifndef DesktopExe
  #error Pass /DDesktopExe=<buddi-desktop.exe> (scripts/release/windows-desktop.sh)
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
AppId={{6F1C9A52-3B7E-4D8A-9E25-B0D7C4F81A36}
AppName=buddi
AppVersion={#AppVersion}
AppVerName=buddi {#AppVersion}
AppPublisher=buddi
AppPublisherURL=https://withbuddi.com
AppSupportURL=https://withbuddi.com
AppUpdatesURL=https://withbuddi.com
VersionInfoVersion={#VersionInfo}
VersionInfoProductName=buddi
VersionInfoDescription=buddi setup
DefaultDirName={autopf}\buddi
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
; One click: the welcome page's button is Install.
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Windows 10 1809: tar.exe and conhost --headless, which the setup and buddi's task both use.
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=buddi-{#AppVersion}-windows-x64-setup
SetupIconFile=buddi.ico
UninstallDisplayIcon={app}\buddi.ico
UninstallDisplayName=buddi
WizardStyle=modern
Compression=lzma2
SolidCompression=no
; buddi stops itself, on its pipe, before anything of it is replaced; Restart
; Manager would end the database without a shutdown.
; Off: Inno Setup's RedirectionGuard reaches the programs it starts (tried on
; Windows 11 24H2 with 6.7.3, though its help says otherwise), and there it
; stops a junction this user made from being followed: `releases\current`
; would read as missing to buddi's own setup program and to buddi itself.
RedirectionGuard=no
CloseApplications=no
; One setup at a time: a second would unpack beside the first and share its folders.
SetupMutex=buddi-setup
RestartApplications=no
ChangesEnvironment=yes
SetupLogging=yes
#ifdef SignTool
SignTool={#SignTool}
SignedUninstaller=yes
#endif

[Messages]
WelcomeLabel2=This installs buddi {#AppVersion} for you on this computer. It needs no administrator rights and nothing else installed.%n%nbuddi runs in the background and you use it in its own window.
FinishedHeadingLabel=buddi is installed
FinishedLabelNoIcons=buddi runs in the background and starts when you sign in. Open it from the Start menu (buddi) or its icon in the notification area; in a new Command Prompt or PowerShell window, type buddi.
FinishedLabel=buddi runs in the background and starts when you sign in. Open it from the Start menu (buddi) or its icon in the notification area; in a new Command Prompt or PowerShell window, type buddi.
ConfirmUninstall=This removes buddi from this computer: its background task, its data and its secrets.%n%nOne last backup is taken first and kept in your user folder (buddi-backups), with the passphrase that opens it.%n%nRemove buddi?

[Files]
Source: "buddi.ico"; DestDir: "{app}"; Flags: ignoreversion
#ifdef SignTool
Source: "{#DesktopExe}"; DestDir: "{app}"; DestName: "buddi-desktop.exe"; Flags: ignoreversion signonce
#else
Source: "{#DesktopExe}"; DestDir: "{app}"; DestName: "buddi-desktop.exe"; Flags: ignoreversion
#endif
#ifdef WebView2Setup
Source: "{#WebView2Setup}"; DestName: "MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy
#endif
; Unpacked by the code below (PrepareToInstall), never copied as it is.
Source: "{#BundleZip}"; DestName: "bundle.zip"; Flags: dontcopy nocompression

[Icons]
Name: "{autoprograms}\buddi"; Filename: "{app}\buddi-desktop.exe"; WorkingDir: "{%USERPROFILE}"; Comment: "buddi, in its own window"; AppUserModelID: "com.withbuddi.desktop"

[Run]
Filename: "{app}\buddi-desktop.exe"; WorkingDir: "{%USERPROFILE}"; Description: "Open buddi"; Flags: postinstall nowait skipifsilent; Check: ShouldStart

[UninstallDelete]
; The app's own: its window's size and place, its WebView2 profile (the dashboard's session), its log.
Type: filesandordirs; Name: "{localappdata}\com.withbuddi.desktop"
Type: filesandordirs; Name: "{userappdata}\com.withbuddi.desktop"
Type: filesandordirs; Name: "{app}\bin"
; The setup program made {app} (for bin\) before Inno Setup did, so Inno Setup does not count it as its own.
Type: dirifempty; Name: "{app}"

[Code]
var
  DataDirValue: String;
  AppWasRunning: Boolean;
  Status: TNewStaticText;
  Busy: TNewProgressBar;

{ What the setup is doing while its program runs, on the Preparing page (which shows nothing by itself). }
procedure InitializeWizard;
begin
  Status := TNewStaticText.Create(WizardForm);
  Status.Parent := WizardForm.PreparingPage;
  Status.Left := 0;
  Status.Top := ScaleY(8);
  Status.Width := WizardForm.PreparingPage.Width;
  Status.AutoSize := False;
  Status.WordWrap := True;
  Status.Height := ScaleY(40);
  Status.Caption := '';
  Busy := TNewProgressBar.Create(WizardForm);
  Busy.Parent := WizardForm.PreparingPage;
  Busy.Left := 0;
  Busy.Top := ScaleY(56);
  Busy.Width := WizardForm.PreparingPage.Width;
  Busy.Height := ScaleY(16);
  Busy.Style := npbstMarquee;
  Busy.Visible := False;
end;

procedure SayStatus(const Text: String);
begin
  Status.Caption := Text;
  Status.Visible := Text <> '';
  Busy.Visible := Text <> '';
  WizardForm.Repaint;
end;

function HasParam(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then Result := True;
end;

function ShouldStart: Boolean;
begin
  Result := not HasParam('/NOSTART') and (GetEnv('BUDDI_NO_START') <> '1');
end;

{ The data folder recorded by the last install of this setup, if any. }
function RegisteredDataDir: String;
begin
  if not RegQueryStringValue(HKCU, 'Software\buddi', 'DataDir', Result) then Result := '';
end;

{ BUDDI_DATA_DIR when set, else the folder this setup installed into before (an upgrade stays where it is), else the default. }
function DataDir: String;
begin
  if DataDirValue = '' then begin
    DataDirValue := GetEnv('BUDDI_DATA_DIR');
    if DataDirValue = '' then DataDirValue := RegisteredDataDir;
    if DataDirValue = '' then DataDirValue := ExpandConstant('{localappdata}\buddi');
  end;
  Result := DataDirValue;
end;

function InitializeSetup: Boolean;
var
  Registered: String;
begin
  Result := True;
  { Postgres will not run with administrator rights, and an elevated install would register buddi for the wrong token. }
  if IsAdmin and not HasParam('/ALLOWADMIN') then begin
    SuppressibleMsgBox('The buddi setup is running as administrator. buddi installs for you only and its database refuses administrator rights.' + #13#10#13#10
      + 'Close this and open the setup again with a double-click (not "Run as administrator").', mbError, MB_OK, IDOK);
    Result := False;
    exit;
  end;
  { One registration per account: a second data folder would take over the first one's uninstall entry. }
  Registered := RegisteredDataDir;
  if (Registered <> '') and (CompareText(RemoveBackslashUnlessRoot(Registered), RemoveBackslashUnlessRoot(DataDir)) <> 0)
    and (FileExists(AddBackslash(Registered) + 'installation.json') or DirExists(AddBackslash(Registered) + 'releases')) then begin
    SuppressibleMsgBox('buddi is already installed for you in ' + Registered + ', and this setup was asked to install into ' + DataDir + '.' + #13#10#13#10
      + 'To upgrade that buddi, run the setup without BUDDI_DATA_DIR. To move to another folder, remove buddi in Settings > Apps first (a last backup is kept).', mbError, MB_OK, IDOK);
    Result := False;
  end;
end;

{ A program run with no console window at all (conhost --headless), waited for.
  conhost does not pass the exit status on: what it ran says how it went in a file. }
procedure RunHidden(const Exe, Params: String);
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\conhost.exe'), '--headless ' + AddQuotes(Exe) + ' ' + Params, GetEnv('USERPROFILE'), SW_HIDE, ewWaitUntilTerminated, Code);
end;

{ The app (buddi-desktop.exe) is asked to quit, as its tray's Quit does, before its file is replaced or removed:
  a second start with --quit reaches the running one and ends at once (with none running, it just ends).
  One that has not gone after a few seconds is ended. Its window is titled buddi. }
function QuitDesktopApp(const Exe: String): Boolean;
var
  Code, I: Integer;
begin
  Result := FindWindowByWindowName('buddi') <> 0;
  if not FileExists(Exe) then exit;
  Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  for I := 1 to 20 do begin
    if FindWindowByWindowName('buddi') = 0 then break;
    Sleep(250);
  end;
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM buddi-desktop.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

{ A running app is told buddi is removed (--removed): it shows its last page and quits when the owner closes it.
  Waited for up to fifteen minutes (the uninstall runs out of sight), then ended. }
procedure LastPageThenQuit(const Exe: String);
var
  Code, I: Integer;
begin
  if (FindWindowByWindowName('buddi') = 0) or not FileExists(Exe) then begin
    QuitDesktopApp(Exe);
    exit;
  end;
  Exec(Exe, '--removed', '', SW_SHOWNORMAL, ewWaitUntilTerminated, Code);
  for I := 1 to 3600 do begin
    if FindWindowByWindowName('buddi') = 0 then break;
    Sleep(250);
  end;
  QuitDesktopApp(Exe);
end;

{ The WebView2 runtime (the Evergreen one: in Windows 11, and Edge's updater keeps it), machine-wide or this user's. }
function WebView2Present: Boolean;
var
  V: String;
begin
  Result := False;
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0') then Result := True
  else if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0') then Result := True
  else if RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0') then Result := True;
end;

procedure EnsureWebView2;
var
  Code: Integer;
begin
  if WebView2Present then exit;
#ifdef WebView2Setup
  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, Code);
  if WebView2Present then exit;
#endif
  Log('WebView2 is not installed: buddi works in the browser, its window needs WebView2 (https://go.microsoft.com/fwlink/p/?LinkId=2124703).');
  if not WizardSilent then
    SuppressibleMsgBox('buddi is installed, but its window needs Microsoft Edge WebView2, which could not be installed now.' + #13#10#13#10
      + 'Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703, or type buddi in a Command Prompt to open buddi in your browser.', mbInformation, MB_OK, IDOK);
end;

{ The Run value the app wrote for Start at Login, when its record says it is that one (windows_rules.rs run_entry_ours). }
procedure RemoveDesktopRunEntry;
var
  Value, Recorded: String;
begin
  if not RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'buddi', Value) then exit;
  if not RegQueryStringValue(HKCU, 'Software\buddi\Desktop', 'RunCommand', Recorded) then exit;
  if Value <> Recorded then exit;
  RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'buddi');
  RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run', 'buddi');
end;

function ReadFirstLine(const FileName: String): String;
var
  Lines: TArrayOfString;
begin
  Result := '';
  if LoadStringsFromFile(FileName, Lines) and (GetArrayLength(Lines) > 0) then Result := Trim(Lines[0]);
end;

{ A whole short file, blank lines kept, for a message box. }
function ReadAll(const FileName: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  if not LoadStringsFromFile(FileName, Lines) then exit;
  for I := 0 to GetArrayLength(Lines) - 1 do Result := Result + Lines[I] + #13#10;
  Result := Trim(Result);
end;

{ The last lines of a log, for a message box. }
function Tail(const FileName: String; Count: Integer): String;
var
  Lines: TArrayOfString;
  I, First: Integer;
begin
  Result := '';
  if not LoadStringsFromFile(FileName, Lines) then exit;
  First := GetArrayLength(Lines) - Count;
  if First < 0 then First := 0;
  for I := First to GetArrayLength(Lines) - 1 do
    if Trim(Lines[I]) <> '' then Result := Result + Lines[I] + #13#10;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Work, Bundle, Node, Script, Params, LogFile, ResultFile, SummaryFile, Kept: String;
begin
  Result := '';
  { The app goes before its file is replaced, and comes back after (ssPostInstall). }
  AppWasRunning := QuitDesktopApp(ExpandConstant('{app}\buddi-desktop.exe'));
  { Unpacked inside the data folder, so the setup program moves it into place with a rename. }
  Work := DataDir + '\.install-' + GetDateTimeString('yyyymmddhhnnss', #0, #0);
  if not ForceDirectories(Work) then begin
    Result := 'buddi could not create ' + Work + '.';
    exit;
  end;
  SayStatus('Unpacking buddi…');
  ExtractTemporaryFile('bundle.zip');
  RunHidden(ExpandConstant('{sys}\tar.exe'), '-xf ' + AddQuotes(ExpandConstant('{tmp}\bundle.zip')) + ' -C ' + AddQuotes(Work));
  Bundle := Work + '\buddi-{#AppVersion}-windows-x64';
  Node := Bundle + '\runtime\node.exe';
  Script := Bundle + '\release\node_modules\@withbuddi\buddi\packages\install\dist\windows-setup.js';
  if not FileExists(Node) or not FileExists(Script) then begin
    DelTree(Work, True, True, True);
    SayStatus('');
    Result := 'buddi could not be unpacked into ' + Work + '. Nothing was changed. Check there is about 1 GB free on that drive, then run the setup again.';
    exit;
  end;
  LogFile := Work + '\setup.log';
  ResultFile := Work + '\result.txt';
  SummaryFile := Work + '\summary.txt';
  Params := AddQuotes(Script) + ' install --bundle ' + AddQuotes(Bundle) + ' --data ' + AddQuotes(DataDir)
    + ' --bin ' + AddQuotes(ExpandConstant('{app}\bin')) + ' --uninstaller ' + AddQuotes(ExpandConstant('{app}\unins000.exe'))
    + ' --log ' + AddQuotes(LogFile) + ' --result ' + AddQuotes(ResultFile) + ' --summary ' + AddQuotes(SummaryFile);
  if not ShouldStart then Params := Params + ' --no-start';
  if HasParam('/SKIPBACKUP') then Params := Params + ' --skip-backup';
  SayStatus('Installing buddi and starting it. When buddi is already here, your data is backed up first. This takes a minute or two.');
  RunHidden(Node, Params);
  SayStatus('');
  Log('buddi setup log:' + #13#10 + Tail(LogFile, 200));
  { What it said stays beside the other logs. }
  Kept := DataDir + '\logs\setup.log';
  ForceDirectories(DataDir + '\logs');
  FileCopy(LogFile, Kept, False);
  if ReadFirstLine(ResultFile) <> '0' then begin
    if FileExists(SummaryFile) then
      Result := 'buddi could not be installed: ' + Tail(SummaryFile, 5)
    else
      Result := 'buddi could not be installed: the setup stopped without saying why. Run it again.';
    Result := Result + #13#10 + 'The details are in ' + Kept + '.';
  end;
  DelTree(Work, True, True, True);
end;

{ The user PATH (HKCU\Environment), with this setup's bin folder once. }
function PathHas(const Path, Dir: String): Boolean;
begin
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Path) + ';') > 0;
end;

procedure AddToPath(const Dir: String);
var
  Path: String;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Path) then Path := '';
  if PathHas(Path, Dir) then exit;
  if (Path <> '') and (Copy(Path, Length(Path), 1) <> ';') then Path := Path + ';';
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Path + Dir);
end;

procedure RemoveFromPath(const Dir: String);
var
  Path: String;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Path) then exit;
  Path := ';' + Path + ';';
  P := Pos(';' + Uppercase(Dir) + ';', Uppercase(Path));
  if P = 0 then exit;
  Delete(Path, P, Length(Dir) + 1);
  Path := Copy(Path, 2, Length(Path) - 2);
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Path);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep = ssPostInstall then begin
    AddToPath(ExpandConstant('{app}\bin'));
    RegWriteStringValue(HKCU, 'Software\buddi', 'DataDir', DataDir);
    EnsureWebView2;
    { A silent upgrade (no Finish page to open it from) puts back the app it quit, in the tray. }
    if AppWasRunning and WizardSilent and ShouldStart then
      Exec(ExpandConstant('{app}\buddi-desktop.exe'), '--hidden', '', SW_SHOWNORMAL, ewNoWait, Code);
  end;
end;

{ buddi uninstall, with a copy of buddi's node from outside the data folder (Windows will not remove a folder whose program runs). }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data, Node, Script, Work, LogFile, Summary, ResultFile, Words: String;
begin
  if CurUninstallStep = usUninstall then begin
    { The app first: Windows will not remove a program that runs. }
    if UninstallSilent then
      { Started by buddi's own removal (the dashboard, buddi uninstall): the app shows its last page, with where the backup is, and goes when the owner closes it. }
      LastPageThenQuit(ExpandConstant('{app}\buddi-desktop.exe'))
    else
      QuitDesktopApp(ExpandConstant('{app}\buddi-desktop.exe'));
    if not RegQueryStringValue(HKCU, 'Software\buddi', 'DataDir', Data) then Data := ExpandConstant('{localappdata}\buddi');
    Node := Data + '\node\node.exe';
    Script := Data + '\releases\current\packages\install\dist\windows-setup.js';
    if not FileExists(Node) or not FileExists(Script) then begin
      { buddi's data is still there but its program is not: removing only the entry would leave the data, the task and the secrets with no way to remove them. }
      if FileExists(Data + '\installation.json') or DirExists(Data + '\postgres') then begin
        if not UninstallSilent then
          MsgBox('buddi''s program files in ' + Data + ' are missing, so its data, background task and secrets cannot be removed safely. Nothing was removed.' + #13#10#13#10
            + 'Run the buddi setup again (it repairs the install), then remove buddi here.', mbError, MB_OK);
        Abort;
      end;
      { Already removed (buddi uninstall from a terminal or the dashboard started this): only the setup's own files are left. }
      exit;
    end;
    { Not buddi-uninstall-: that prefix is the launcher's own node copy, which it removes once it exits. }
    Work := AddBackslash(GetTempDir) + 'buddi-setup-uninstall-' + GetDateTimeString('yyyymmddhhnnss', #0, #0);
    ForceDirectories(Work);
    if not FileCopy(Node, Work + '\node.exe', False) then begin
      if not UninstallSilent then MsgBox('buddi could not be removed: its node could not be copied to ' + Work + '. Nothing was removed.', mbError, MB_OK);
      Abort;
    end;
    LogFile := Work + '\uninstall.log';
    Summary := Work + '\summary.txt';
    ResultFile := Work + '\result.txt';
    RunHidden(Work + '\node.exe', AddQuotes(Script) + ' uninstall --data ' + AddQuotes(Data) + ' --log ' + AddQuotes(LogFile)
      + ' --summary ' + AddQuotes(Summary) + ' --result ' + AddQuotes(ResultFile));
    Log('buddi uninstall log:' + #13#10 + Tail(LogFile, 200));
    if ReadFirstLine(ResultFile) <> '0' then begin
      if not UninstallSilent then
        MsgBox('buddi could not be removed, so nothing else was either.' + #13#10#13#10 + Tail(LogFile, 12), mbError, MB_OK);
      Abort;
    end;
    Words := ReadAll(Summary);
    if (Words <> '') and not UninstallSilent then MsgBox(Words, mbInformation, MB_OK);
    DelTree(Work, True, True, True);
  end;
  if CurUninstallStep = usPostUninstall then begin
    RemoveFromPath(ExpandConstant('{app}\bin'));
    RemoveDesktopRunEntry;
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\buddi');
  end;
end;

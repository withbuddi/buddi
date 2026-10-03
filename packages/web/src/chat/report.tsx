/**
 * `mission.report` as the chat draws it (host API 1.27): what an unattended
 * run sent the owner — the voice note first when it carried one, then the
 * text as it went out, then the button its `link` opens ("Open edition").
 *
 * The run's conversation is where a scheduled message is read again on the
 * dashboard, so the report is drawn as the message it was rather than as a
 * tool row. The link is a dashboard route only; a web address is no button.
 */
import { AudioCard, isPlayableAudio } from './AudioCard';
import { Markdown } from './markdown';

export const REPORT_TOOL = 'mission.report';

export interface ReportView {
  text: string | null;
  link: { route: string; label: string } | null;
  audio: { fileId: string; mime: string; filename: string | null; sizeBytes: number | null } | null;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The call's text, and the link and voice note the tool answered with. */
export function reportView(input: unknown, output: unknown): ReportView {
  const call = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out = output !== null && typeof output === 'object' ? (output as Record<string, unknown>) : {};
  const route = str(out['link']);
  const audio = out['audio'] !== null && typeof out['audio'] === 'object' ? (out['audio'] as Record<string, unknown>) : null;
  const fileId = audio ? str(audio['fileId']) : null;
  const mime = audio ? str(audio['mime']) : null;
  return {
    text: str(call['text']),
    link: route && route.startsWith('#/') ? { route, label: str(out['linkLabel']) ?? 'Open' } : null,
    audio:
      fileId && UUID.test(fileId) && mime && isPlayableAudio(mime)
        ? {
            fileId,
            mime,
            filename: audio ? str(audio['filename']) : null,
            sizeBytes: audio && typeof audio['sizeBytes'] === 'number' ? (audio['sizeBytes'] as number) : null,
          }
        : null,
  };
}

/** The report as it was sent: the player above the text, the link under it. */
export function MissionReport({ view }: { view: ReportView }): JSX.Element | null {
  if (!view.text && !view.audio) return null;
  return (
    <div className="wb-report" data-testid="mission-report">
      {view.audio ? (
        <AudioCard artifactId={view.audio.fileId} name={view.audio.filename ?? 'Voice note'} mime={view.audio.mime} sizeBytes={view.audio.sizeBytes} />
      ) : null}
      {view.text ? (
        <div className="wb-bubble" data-rich="true">
          <Markdown text={view.text} />
        </div>
      ) : null}
      {view.link ? (
        <a className="ui-btn wb-report-link" data-size="sm" href={view.link.route}>
          {view.link.label}
        </a>
      ) : null}
    </div>
  );
}

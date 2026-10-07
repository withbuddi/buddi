/** Keep executor-supplied material available without turning the chat into a JSON viewer. */
export function MissionRequestText({ text }: { text: string }): JSX.Element {
  const marker = '\n\nThe material this mission reads first';
  const start = text.indexOf(marker);
  const match = /<DATA-([a-f0-9]+)>/.exec(text.slice(start));
  if (start < 0 || !match || !text.includes(`</DATA-${match[1]}>`)) return <>{text}</>;
  return <>{text.slice(0, start)}<details className="wb-mission-material"><summary>Edition material · supplied to the agent</summary><pre>{text.slice(start + 2)}</pre></details></>;
}

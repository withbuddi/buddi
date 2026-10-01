import { useEffect, useState } from 'react';

/** The minute, re-read on the minute. */
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => { setNow(new Date()); arm(); }, 60_000 - (Date.now() % 60_000) + 50);
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return now;
}


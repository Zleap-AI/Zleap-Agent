import { useEffect, useState, type ReactElement } from 'react';
import { Text } from 'ink';
import { BRAND_GOLD } from './theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner(): ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <Text color={BRAND_GOLD}>{FRAMES[frame]} 思考中…</Text>;
}

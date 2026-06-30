import { useEffect, useState, type ReactElement } from 'react';
import { Text } from 'ink';
import { isAnimated, mascotColor, mascotFace, mascotFrameMs, type MascotMood } from './mascotMood.js';

type MascotProps = {
  mood: MascotMood;
};

export function Mascot({ mood }: MascotProps): ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
    if (!isAnimated(mood)) {
      return;
    }
    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, mascotFrameMs(mood));
    return () => clearInterval(timer);
  }, [mood]);

  return <Text color={mascotColor(mood)}>{mascotFace(mood, frame)}</Text>;
}

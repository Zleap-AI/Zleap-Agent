'use client';

import clsx from 'clsx';
import { useEffect, useRef } from 'react';

// Block wordmark for the home hero. String.raw keeps spacing stable so the
// monospace glyphs align exactly.
const WORDMARK = String.raw`███████╗ ██╗      ███████╗  █████╗  ██████╗
╚══███╔╝ ██║      ██╔════╝ ██╔══██╗ ██╔══██╗
  ███╔╝  ██║      █████╗   ███████║ ██████╔╝
 ███╔╝   ██║      ██╔══╝   ██╔══██║ ██╔═══╝
███████╗ ███████╗ ███████╗ ██║  ██║ ██║
╚══════╝ ╚══════╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝`;
const WORDMARK_LINES = WORDMARK.split('\n');
const BASE_WIDTH = 560;
const BASE_HEIGHT = 116;
const BASE_FONT_SIZE = 18;
const LINE_HEIGHT = 18;
const ANIMATION_MS = 10_000;

/**
 * The Zleap block wordmark, used on the home hero.
 */
export function Wordmark({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let animationFrame = 0;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const draw = (timestamp: number) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        animationFrame = window.requestAnimationFrame(draw);
        return;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.round(rect.width * dpr);
      const pixelHeight = Math.round(rect.height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      context.setTransform((rect.width / BASE_WIDTH) * dpr, 0, 0, (rect.height / BASE_HEIGHT) * dpr, 0, 0);
      context.clearRect(0, 0, BASE_WIDTH, BASE_HEIGHT);
      context.font = `800 ${BASE_FONT_SIZE}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
      context.textBaseline = 'alphabetic';
      context.textAlign = 'left';
      const maxLineWidth = Math.max(...WORDMARK_LINES.map((line) => context.measureText(line).width));
      const textX = Math.max(0, (BASE_WIDTH - maxLineWidth) / 2);

      context.fillStyle = 'rgba(180, 121, 64, 0.34)';
      for (const [index, line] of WORDMARK_LINES.entries()) {
        context.fillText(line, textX + 2, BASE_FONT_SIZE + index * LINE_HEIGHT + 2);
      }

      const progress = reduceMotion ? 0.35 : (timestamp % ANIMATION_MS) / ANIMATION_MS;
      const eased = (1 - Math.cos(progress * Math.PI * 2)) / 2;
      const offset = eased * BASE_HEIGHT;
      const gradient = context.createLinearGradient(0, -BASE_HEIGHT + offset, 0, BASE_HEIGHT + offset);
      gradient.addColorStop(0, 'rgb(244, 203, 137)');
      gradient.addColorStop(0.34, 'rgb(206, 143, 78)');
      gradient.addColorStop(0.68, 'rgb(150, 82, 37)');
      gradient.addColorStop(1, 'rgb(226, 171, 100)');
      context.fillStyle = gradient;
      for (const [index, line] of WORDMARK_LINES.entries()) {
        context.fillText(line, textX, BASE_FONT_SIZE + index * LINE_HEIGHT);
      }

      if (!reduceMotion) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    animationFrame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Zleap"
      width={BASE_WIDTH}
      height={BASE_HEIGHT}
      className={clsx(
        'zleap-wordmark mx-auto block aspect-[140/29] h-auto w-[min(58vw,560px)] max-w-full select-none',
        className,
      )}
    />
  );
}

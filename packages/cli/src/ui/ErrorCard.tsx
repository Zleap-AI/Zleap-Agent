import type { ReactElement } from 'react';
import { Box, Text } from 'ink';

type ErrorCardProps = {
  message: string;
  title?: string;
};

/** Distinct error block — not the same as gray system notify. */
export function ErrorCard({ message, title = '错误' }: ErrorCardProps): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="red" paddingX={1}>
      <Text bold color="redBright">
        {title}
      </Text>
      <Text wrap="wrap">{message}</Text>
    </Box>
  );
}

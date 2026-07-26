import { Text } from "ink";

export interface LoginViewProps {
  readonly code: string;
  readonly verificationUrl: string;
}

export const LoginView = ({
  code,
  verificationUrl,
}: LoginViewProps): React.JSX.Element => (
  <>
    <Text color="cyan">Authorize Aleph CLI in your browser</Text>
    <Text>
      Code: <Text bold>{code}</Text>
    </Text>
    <Text dimColor>{verificationUrl}</Text>
    <Text color="yellow">Waiting for approval…</Text>
  </>
);

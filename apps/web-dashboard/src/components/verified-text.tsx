import DecryptedText from './DecryptedText';

export function VerifiedText({ text, className = '' }: Readonly<{ text: string; className?: string }>) {
  return (
    <DecryptedText
      text={text}
      speed={24}
      maxIterations={8}
      sequential
      revealDirection="start"
      characters="0123456789abcdefABCDEF_-.:"
      animateOn="view"
      parentClassName={`verified-text${className ? ` ${className}` : ''}`}
      className="verified-text__resolved"
      encryptedClassName="verified-text__encrypted"
    />
  );
}

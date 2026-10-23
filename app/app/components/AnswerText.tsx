import { answerParts } from '../../lib/answer-links.ts';

export default function AnswerText({ text }: { text: string }) {
  return <>{answerParts(text).map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: 'anywhere', textDecoration: 'underline' }}>{part.text}</a>
    : <span key={index}>{part.text}</span>)}</>;
}

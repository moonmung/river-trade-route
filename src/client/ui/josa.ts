// 한국어 조사 고르기: 이름 끝 글자에 받침이 있으면 앞쪽, 없으면 뒤쪽.
// 한글이 아닌 이름은 '이(가)'처럼 둘 다 적는다.

type Pair = '이/가' | '은/는' | '을/를' | '과/와' | '으로/로';

export function josa(word: string, pair: Pair): string {
  const [withFinal, withoutFinal] = pair.split('/') as [string, string];
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const final = (code - 0xac00) % 28;
    if (pair === '으로/로') return word + (final === 0 || final === 8 ? withoutFinal : withFinal);
    return word + (final ? withFinal : withoutFinal);
  }
  if (/[0-9]$/.test(last)) {
    const hasFinal = '013678'.includes(last);
    return word + (hasFinal ? withFinal : withoutFinal);
  }
  return `${word}${withFinal}(${withoutFinal})`;
}

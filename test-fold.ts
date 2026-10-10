import { Buffer } from 'node:buffer';

function foldLine(line: string): string {
  let result = '';
  let currentBytes = 0;
  for (const char of line) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (currentBytes + charBytes > 75 && currentBytes > 0) {
      result += '\r\n ';
      currentBytes = 1;
    }
    result += char;
    currentBytes += charBytes;
  }
  return result;
}

console.log(foldLine('SUMMARY:' + 'A'.repeat(80)));

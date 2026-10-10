function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;

  let folded = '';
  let currentLineBytes = 0;

  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    if (currentLineBytes + charBytes > 75) {
      folded += '\r\n ';
      currentLineBytes = 1; // The space counts as 1 byte
    }
    folded += char;
    currentLineBytes += charBytes;
  }

  return folded;
}
console.log(foldLine('SUMMARY:' + 'A'.repeat(80)));
console.log(foldLine('SUMMARY:' + '✓'.repeat(80)));

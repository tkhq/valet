import { describe, expect, it } from 'vitest';
import { tablesToLabeledRows } from './table-format.js';

describe('tablesToLabeledRows', () => {
  it('bounds repeated header expansion before formatting discarded rows', () => {
    const text = '|' + 'h'.repeat(5000) + '|\n|-|\n' + '|x|\n'.repeat(1500) + '<@U123>';
    const result = tablesToLabeledRows(text, 6000);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(6000);
    expect(result.text).toContain('**: x');
  });

  it('preserves escaped pipes, code, empty cells, and surrounding prose', () => {
    const text = 'Before\n\n| Value | Empty |\n|-|-|\n| `a\\|b` | |\n\nAfter';
    expect(tablesToLabeledRows(text, 150_000).text).toBe('Before\n\n**Value**: `a|b`\n**Empty**: \n\n\nAfter');
  });

  it.each(['```', '~~~~'])( 'leaves table examples inside %s fences alone', (fence) => {
    const text = `${fence}\n| Value |\n|-|\n| <@U123> |\n${fence}`;
    expect(tablesToLabeledRows(text, 150_000).text).toBe(text);
  });

  it('leaves indented code and mismatched table headers alone', () => {
    const text = '    | Value |\n    |-|\n    | <@U123> |\n\n| a | b |\n|-|\n| c |';
    expect(tablesToLabeledRows(text, 150_000).text).toBe(text);
  });

  it('keeps headings and quotes after a table outside its rows', () => {
    const text = '| a | b |\n|-|-|\n| 1 | 2 |\n# Next | section\n> quoted | text';
    expect(tablesToLabeledRows(text, 150_000).text).toBe('**a**: 1\n**b**: 2\n\n# Next | section\n> quoted | text');
  });

  it('keeps header-only tables and cells with missing headers readable', () => {
    expect(tablesToLabeledRows('| a | b |\n|-|-|', 150_000).text).toBe('**a**\n**b**\n');
    expect(tablesToLabeledRows('| a | |\n|-|-|\n| 1 | 2 | 3 |', 150_000).text).toBe('**a**: 1\n**Column 2**: 2\n**Column 3**: 3\n');
  });
});

/**
 * Markdown to HTML conversion utilities
 */

/**
 * Render a table from parsed rows
 */
export function renderTable(rows: string[][]): string {
  if (rows.length === 0) return '';

  let html = '<table>';

  // First row is header
  html += '<thead><tr>';
  for (const cell of rows[0]) {
    html += `<th>${cell}</th>`;
  }
  html += '</tr></thead>';

  // Rest are body rows
  if (rows.length > 1) {
    html += '<tbody>';
    for (let i = 1; i < rows.length; i++) {
      html += '<tr>';
      for (const cell of rows[i]) {
        html += `<td>${cell}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
  }

  html += '</table>';
  return html;
}

/**
 * Simple markdown to HTML converter
 */
export function convertMarkdownToHtml(markdown: string): string {
  // First, process tables before escaping HTML (tables need special handling)
  const lines = markdown.split('\n');
  const processedLines: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableLine = /^\|.+\|$/.test(line.trim());

    if (isTableLine) {
      // Parse table row
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());

      // Check if separator row (|---|---|)
      const isSeparator = cells.every(c => /^[-:]+$/.test(c));

      if (!inTable) {
        inTable = true;
        tableRows = [];
      }

      if (!isSeparator) {
        tableRows.push(cells);
      }
    } else {
      // Not a table line - flush any accumulated table
      if (inTable && tableRows.length > 0) {
        processedLines.push(renderTable(tableRows));
        tableRows = [];
        inTable = false;
      }
      processedLines.push(line);
    }
  }

  // Flush remaining table if file ends with table
  if (inTable && tableRows.length > 0) {
    processedLines.push(renderTable(tableRows));
  }

  let html = processedLines.join('\n');

  // Escape HTML entities (but preserve our rendered tables)
  html = html.replace(/&(?!amp;|lt;|gt;)/g, '&amp;');
  html = html.replace(/<(?!\/?(?:table|thead|tbody|tr|th|td|pre|code|h[1-4]|ul|ol|li|p|br|hr|blockquote|strong|em|a|input)[>\s/])/g, '&lt;');
  html = html.replace(/(?<!<\/?(?:table|thead|tbody|tr|th|td|pre|code|h[1-4]|ul|ol|li|p|br|hr|blockquote|strong|em|a|input)[^>]*)>/g, '&gt;');

  // Code blocks (``` ... ```) - must be before other processing
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

  // Inline code (but not inside pre blocks)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists (numbered)
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Checkboxes
  html = html.replace(/\[x\]/g, '<input type="checkbox" checked disabled>');
  html = html.replace(/\[ \]/g, '<input type="checkbox" disabled>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Paragraphs (double newlines)
  html = html.replace(/\n\n(?!<)/g, '</p><p>');

  // Single line breaks - just remove them (let text flow naturally)
  html = html.replace(/\n(?!<)/g, ' ');

  // Wrap in paragraph if not already wrapped
  if (!html.startsWith('<')) {
    html = '<p>' + html + '</p>';
  }

  // Clean up empty paragraphs
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>\s*<(h[1-4]|ul|ol|table|pre|blockquote|hr)/g, '<$1');
  html = html.replace(/<\/(h[1-4]|ul|ol|table|pre|blockquote)>\s*<\/p>/g, '</$1>');

  return html;
}

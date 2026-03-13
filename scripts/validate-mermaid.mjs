#!/usr/bin/env node
/**
 * Validates Mermaid diagram syntax in markdown files.
 * Exits with code 1 if any diagrams fail to parse.
 *
 * @format
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DOCS_DIR = './docs';

/**
 * Extract mermaid blocks from markdown content
 * @param {string} content - File content
 * @returns {Array<{code: string, line: number}>}
 */
function extractMermaidBlocks(content) {
  const blocks = [];
  const lines = content.split('\n');
  let inMermaid = false;
  let currentBlock = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('```mermaid')) {
      inMermaid = true;
      currentBlock = [];
      startLine = i + 1;
    } else if (inMermaid && line.trim() === '```') {
      inMermaid = false;
      blocks.push({
        code: currentBlock.join('\n'),
        line: startLine,
      });
      currentBlock = [];
    } else if (inMermaid) {
      currentBlock.push(line);
    }
  }

  // Check for unclosed mermaid block at EOF
  if (inMermaid) {
    blocks.push({
      code: currentBlock.join('\n'),
      line: startLine,
      unclosed: true,
    });
  }

  return blocks;
}

/**
 * Basic syntax validation for Mermaid diagrams
 * Checks for common structural issues
 * @param {string} code - Mermaid code
 * @returns {Array<string>} - Array of error messages
 */
function validateMermaidSyntax(code) {
  const errors = [];
  const lines = code.split('\n');
  const firstLine = lines[0].trim();

  // Check for empty diagrams
  if (!code.trim()) {
    errors.push('Diagram is empty');
    return errors;
  }

  // Detect diagram type and validate accordingly
  const diagramType = firstLine.toLowerCase();

  if (diagramType.startsWith('flowchart') || diagramType.startsWith('graph')) {
    // Flowchart validations
    const hasNodes = /\w+\s*[\[\(\{<\[]/.test(code);
    const hasArrows = /--?>/.test(code);

    if (!hasNodes) {
      errors.push('Flowchart: No nodes detected (nodes should use brackets like [text] or (text))');
    }
    if (!hasArrows) {
      errors.push('Flowchart: No arrows detected (use --> or ==> for connections)');
    }
  } else if (diagramType.startsWith('sequencediagram')) {
    // Sequence diagram validations
    const hasParticipants = /participant\s+\w+/i.test(code);
    const hasArrows = ['->', '-->', '->>', '-->>'].some((arrowToken) => code.includes(arrowToken));

    if (!hasParticipants) {
      errors.push('Sequence diagram: No participants declared');
    }
    if (!hasArrows) {
      errors.push('Sequence diagram: No arrows detected (use ->, -->, ->>, or -->>)');
    }
  } else if (diagramType.startsWith('classdiagram')) {
    // Class diagram validations
    const hasClasses = /class\s+\w+/i.test(code);
    if (!hasClasses) {
      errors.push('Class diagram: No classes declared');
    }
  } else if (diagramType.startsWith('erdiagram')) {
    // ER diagram validations
    const hasEntities = /\w+\s+\{/.test(code);
    if (!hasEntities) {
      errors.push('ER diagram: No entities declared');
    }
  } else if (diagramType.startsWith('gantt')) {
    // Gantt validations
    const hasSections = /section\s+\w+/i.test(code);
    if (!hasSections) {
      errors.push('Gantt: No sections declared');
    }
  } else if (diagramType.startsWith('pie')) {
    // Pie chart validations
    const hasData = /"[^"]+"\s*:\s*\d+/.test(code);
    if (!hasData) {
      errors.push('Pie chart: No data entries found (use "label" : value format)');
    }
  }

  // Common validations for all diagram types
  // Check for unclosed quotes
  const quoteMatches = code.match(/"/g) || [];
  if (quoteMatches.length % 2 !== 0) {
    errors.push('Unclosed quote detected');
  }

  return errors;
}

/**
 * Main validation function
 */
function main() {
  console.log('🔍 Validating Mermaid diagrams in docs/...\n');

  let totalDiagrams = 0;
  let totalErrors = 0;
  const fileResults = [];

  try {
    const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'));

    if (files.length === 0) {
      console.log('⚠️  No markdown files found in docs/');
      process.exit(0);
    }

    for (const file of files) {
      const filePath = join(DOCS_DIR, file);
      const content = readFileSync(filePath, 'utf8');
      const blocks = extractMermaidBlocks(content);

      if (blocks.length === 0) {
        continue;
      }

      console.log(`📄 ${file} (${blocks.length} diagram${blocks.length > 1 ? 's' : ''})`);

      const fileErrors = [];
      for (const block of blocks) {
        totalDiagrams++;

        // Check for unclosed blocks first
        if (block.unclosed) {
          totalErrors++;
          fileErrors.push({
            line: block.line,
            errors: ['Unclosed mermaid block (missing closing ```)'],
          });
          continue;
        }

        const errors = validateMermaidSyntax(block.code);

        if (errors.length > 0) {
          totalErrors += errors.length;
          fileErrors.push({ line: block.line, errors });
        }
      }

      if (fileErrors.length > 0) {
        fileResults.push({ file, errors: fileErrors });
        for (const { line, errors } of fileErrors) {
          console.log(`  ❌ Line ${line}:`);
          for (const error of errors) {
            console.log(`     - ${error}`);
          }
        }
      } else {
        console.log('  ✅ All diagrams valid');
      }
      console.log();
    }

    console.log(`📊 Summary: ${totalDiagrams} diagram(s) checked, ${totalErrors} error(s) found`);

    if (totalErrors > 0) {
      console.log('\n❌ Validation failed');
      process.exit(1);
    } else {
      console.log('\n✅ All Mermaid diagrams are valid!');
      process.exit(0);
    }
  } catch (error) {
    console.error('💥 Error:', error.message);
    process.exit(1);
  }
}

main();

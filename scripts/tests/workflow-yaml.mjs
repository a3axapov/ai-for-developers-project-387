import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

// Parse a workflow document, rejecting YAML that is not a mapping. Tests use
// this so that assertions read the same structure GitHub Actions sees.
export function parseWorkflow(source) {
  const document = parse(source);
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  )
    throw new TypeError('Workflow YAML must be a mapping');
  return document;
}

export async function readWorkflow(path) {
  return parseWorkflow(await readFile(path, 'utf8'));
}

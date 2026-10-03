#!/usr/bin/env node
// MCP stdio server for one Polycards staff desk (spec
// docs/superpowers/specs/2026-09-29-desk-reports-design.md). Hermes starts it
// with REPORTS_DESK, REPORTS_BASE_URL and REPORTS_KEY (the desk's key,
// interpolated from the profile's .env); it exposes every desk's read-only
// report tools, since every desk reads every report (2026-10-03).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ALL_TOOLS, TOOLS, runTool } from './tools.mjs';

const desk = process.env.REPORTS_DESK ?? '';
const config = {
  desk,
  baseUrl: process.env.REPORTS_BASE_URL || 'https://admin.polycards.gg',
  key: process.env.REPORTS_KEY ?? '',
};
// Developer holds a key but owns no reports.
if (!Object.hasOwn(TOOLS, desk) && desk !== 'developer') {
  console.error(`desk-reports: unknown REPORTS_DESK "${desk}"`);
  process.exit(1);
}
// stdout is the MCP channel. This line goes to stderr, which Hermes logs: it
// proves the key arrived without printing it.
const configured = config.key.length >= 32 && !config.key.startsWith('${');
console.error(
  `desk-reports: desk ${desk}, backend ${config.baseUrl}, key configured: ${configured ? 'yes' : 'no'} (${config.key.length} chars)`,
);

const server = new McpServer({
  name: `polycards-${desk}-reports`,
  version: '1.0.0',
});
for (const tool of ALL_TOOLS) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool(tool, args, config),
  );
}
await server.connect(new StdioServerTransport());

import { createBashTool } from "./bash-tool.js";
import { createEditTool } from "./edit-tool.js";
import { createGlobTool } from "./glob-tool.js";
import { createGrepTool } from "./grep-tool.js";
import { createReadTool } from "./read-tool.js";
import type { Tool } from "./tool-environment.js";
import { createWriteTool } from "./write-tool.js";

export function createCodingTools(workspace: string, options: { bashPath?: string } = {}): Tool[] {
  return [
    createReadTool(workspace),
    createGlobTool(workspace),
    createGrepTool(workspace),
    createBashTool(workspace, options.bashPath),
    createEditTool(workspace),
    createWriteTool(workspace),
  ];
}

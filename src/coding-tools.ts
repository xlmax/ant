import type { Tool } from "./core/environment.js";
import { createBashTool } from "./tools/bash-tool.js";
import { createEditTool } from "./tools/edit-tool.js";
import { createGlobTool } from "./tools/glob-tool.js";
import { createGrepTool } from "./tools/grep-tool.js";
import { createReadTool } from "./tools/read-tool.js";
import { createWriteTool } from "./tools/write-tool.js";

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

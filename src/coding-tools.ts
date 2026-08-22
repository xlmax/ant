import type { Tool } from "./core/environment.js";
import { createBashTool } from "./tools/bash-tool.js";
import { createEditTool } from "./tools/edit-tool.js";
import { createReadTool } from "./tools/read-tool.js";
import { createWriteTool } from "./tools/write-tool.js";

export function createCodingTools(workspace: string): Tool[] {
  return [
    createReadTool(workspace),
    createBashTool(workspace),
    createEditTool(workspace),
    createWriteTool(workspace),
  ];
}

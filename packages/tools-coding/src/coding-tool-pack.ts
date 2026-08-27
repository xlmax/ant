import type { ToolPack } from "@ant/app";
import { createBashTool } from "./bash-tool.js";
import { createEditTool } from "./edit-tool.js";
import { createGlobTool } from "./glob-tool.js";
import { createGrepTool } from "./grep-tool.js";
import { createReadTool } from "./read-tool.js";
import { createWriteTool } from "./write-tool.js";

export const codingToolPack: ToolPack = {
  id: "ant.coding-tools",
  create(context) {
    return [
      createReadTool(context.workspace),
      createGlobTool(context.workspace),
      createGrepTool(context.workspace),
      createBashTool(context.workspace, context.process.bashPath),
      createEditTool(context.workspace),
      createWriteTool(context.workspace),
    ];
  },
};

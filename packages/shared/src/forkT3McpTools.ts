import {
  BOARD_ADD_TOOL_NAME,
  BOARD_LIST_TOOL_NAME,
  BOARD_UPDATE_TOOL_NAME,
  MEMORY_PROPOSE_TOOL_NAME,
} from "@t3tools/contracts";

/** The fork's tools on T3's MCP server, so agents that only title a call still name it as T3's. */
export const FORK_T3_MCP_TOOL_NAMES = [
  BOARD_ADD_TOOL_NAME,
  BOARD_UPDATE_TOOL_NAME,
  BOARD_LIST_TOOL_NAME,
  MEMORY_PROPOSE_TOOL_NAME,
];

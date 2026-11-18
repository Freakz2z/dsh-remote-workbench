export class WorkbenchError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
    public status = 400,
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}
export function errorBody(error: unknown) {
  return error instanceof WorkbenchError
    ? { code: error.code, message: error.message, details: error.details }
    : {
        code: "REMOTE_ERROR",
        message: error instanceof Error ? error.message : "操作失败",
      };
}
export function absolutePath(value: string) {
  if (!value.startsWith("/") || value.includes("\0"))
    throw new WorkbenchError("INVALID_PATH", "请输入远程绝对路径");
  return value;
}
export const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";

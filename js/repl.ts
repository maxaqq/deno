// Copyright 2018-2019 the Deno authors. All rights reserved. MIT license.
import { assert } from "./util";
import { close } from "./files";
import { sendSync, sendAsync, msg, flatbuffers } from "./dispatch_flatbuffers";
import { exit } from "./os";
import { window } from "./window";
import { core } from "./core";
import { formatError } from "./format_error";
import { stringifyArgs } from "./console";

/**
 * REPL logging.
 * In favor of console.log to avoid unwanted indentation
 */
function replLog(...args: unknown[]): void {
  core.print(stringifyArgs(args) + "\n");
}

/**
 * REPL logging for errors.
 * In favor of console.error to avoid unwanted indentation
 */
function replError(...args: unknown[]): void {
  core.print(stringifyArgs(args) + "\n", true);
}

const helpMsg = [
  "exit    Exit the REPL",
  "help    Print this help message"
].join("\n");

const replCommands = {
  exit: {
    get(): void {
      exit(0);
    }
  },
  help: {
    get(): string {
      return helpMsg;
    }
  }
};

function startRepl(historyFile: string): number {
  const builder = flatbuffers.createBuilder();
  const historyFile_ = builder.createString(historyFile);
  const inner = msg.ReplStart.createReplStart(builder, historyFile_);

  const baseRes = sendSync(builder, msg.Any.ReplStart, inner);
  assert(baseRes != null);
  assert(msg.Any.ReplStartRes === baseRes!.innerType());
  const innerRes = new msg.ReplStartRes();
  assert(baseRes!.inner(innerRes) != null);
  const rid = innerRes.rid();
  return rid;
}

// @internal
export async function readline(rid: number, prompt: string): Promise<string> {
  const builder = flatbuffers.createBuilder();
  const prompt_ = builder.createString(prompt);
  const inner = msg.ReplReadline.createReplReadline(builder, rid, prompt_);

  const baseRes = await sendAsync(builder, msg.Any.ReplReadline, inner);

  assert(baseRes != null);
  assert(msg.Any.ReplReadlineRes === baseRes!.innerType());
  const innerRes = new msg.ReplReadlineRes();
  assert(baseRes!.inner(innerRes) != null);
  const line = innerRes.line();
  assert(line !== null);
  return line || "";
}

// Error messages that allow users to continue input
// instead of throwing an error to REPL
// ref: https://github.com/v8/v8/blob/master/src/message-template.h
// TODO(kevinkassimo): this list might not be comprehensive
const recoverableErrorMessages = [
  "Unexpected end of input", // { or [ or (
  "Missing initializer in const declaration", // const a
  "Missing catch or finally after try", // try {}
  "missing ) after argument list", // console.log(1
  "Unterminated template literal" // `template
  // TODO(kevinkassimo): need a parser to handling errors such as:
  // "Missing } in template expression" // `${ or `${ a 123 }`
];

function isRecoverableError(e: Error): boolean {
  return recoverableErrorMessages.includes(e.message);
}

// Evaluate code.
// Returns true if code is consumed (no error/irrecoverable error).
// Returns false if error is recoverable
function evaluate(code: string): boolean {
  const [result, errInfo] = core.evalContext(code);
  if (!errInfo) {
    replLog(result);
  } else if (errInfo.isCompileError && isRecoverableError(errInfo.thrown)) {
    // Recoverable compiler error
    return false; // don't consume code.
  } else {
    if (errInfo.isNativeError) {
      const formattedError = formatError(
        core.errorToJSON(errInfo.thrown as Error)
      );
      replError(formattedError);
    } else {
      replError("Thrown:", errInfo.thrown);
    }
  }
  return true;
}

// @internal
export async function replLoop(): Promise<void> {
  Object.defineProperties(window, replCommands);

  const historyFile = "deno_history.txt";
  const rid = startRepl(historyFile);

  const quitRepl = (exitCode: number): void => {
    // Special handling in case user calls deno.close(3).
    try {
      close(rid); // close signals Drop on REPL and saves history.
    } catch {}
    exit(exitCode);
  };

  while (true) {
    let code = "";
    // Top level read
    try {
      code = await readline(rid, "> ");
      if (code.trim() === "") {
        continue;
      }
    } catch (err) {
      if (err.message === "EOF") {
        quitRepl(0);
      } else {
        // If interrupted, don't print error.
        if (err.message !== "Interrupted") {
          // e.g. this happens when we have deno.close(3).
          // We want to display the problem.
          const formattedError = formatError(core.errorToJSON(err));
          replError(formattedError);
        }
        // Quit REPL anyways.
        quitRepl(1);
      }
    }
    // Start continued read
    while (!evaluate(code)) {
      code += "\n";
      try {
        code += await readline(rid, "  ");
      } catch (err) {
        // If interrupted on continued read,
        // abort this read instead of quitting.
        if (err.message === "Interrupted") {
          break;
        } else if (err.message === "EOF") {
          quitRepl(0);
        } else {
          // e.g. this happens when we have deno.close(3).
          // We want to display the problem.
          const formattedError = formatError(core.errorToJSON(err));
          replError(formattedError);
          quitRepl(1);
        }
      }
    }
  }
}

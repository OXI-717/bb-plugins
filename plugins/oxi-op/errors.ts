// The code survives the host RPC as a message prefix; only the code is ever recorded.
export class CodedError extends Error {
    constructor(readonly code: string, message: string) {super('[' + code + '] ' + message);}
}
export const errorCode = (error: unknown) => /\[([a-z0-9-]{1,40})\]/.exec(error instanceof Error ? error.message : '')?.[1];

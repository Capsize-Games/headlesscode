/** The narrow entrypoint shared by the visible CLI and protected RSI commands. */
export interface RsiCliOutputSink {
	write(text: string): unknown
}

export interface RsiCliIO {
	stdout: RsiCliOutputSink
	stderr: RsiCliOutputSink
}

export interface RsiCliEntrypoint {
	(argv: string[], io: RsiCliIO): Promise<number>
}

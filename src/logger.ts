import { format } from "date-fns";
import { white } from "console-log-colors";

class Logger {
	private isDev: boolean;

	constructor() {
		this.isDev = process.env['ENVIRONMENT'] === 'development';
		return this;
	}

	init = async () => {};

	log(message: string) {
		const timestamp = format(new Date(), "dd-MM-yyyy HH:mm.ss.SSS");
		const coloredTimestamp = white.bold(`${timestamp}`);
		console.log(`${coloredTimestamp} - ${message}`);
	}

	// Log only in development mode (for verbose game/websocket logging)
	logDev(message: string) {
		if (!this.isDev) return;
		const timestamp = format(new Date(), "dd-MM-yyyy HH:mm.ss.SSS");
		const coloredTimestamp = white.bold(`${timestamp}`);
		console.log(`${coloredTimestamp} - ${message}`);
	}
}

export default Logger;

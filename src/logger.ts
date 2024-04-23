import { format } from "date-fns";
import { white } from "console-log-colors";

class Logger {
	constructor() {
		return this;
	}

	init = async () => {};

	log(message: string) {
		const timestamp = format(new Date(), "dd-MM-yyyy HH:mm.ss.SSS");
		const coloredTimestamp = white.bold(`${timestamp}`);
		console.log(`${coloredTimestamp} - ${message}`);
	}
}

export default Logger;

import { assertConsoleConfiguration } from './configuration';
/** Nitro invokes synchronous runtime plugins before its node-server entry calls serve(). */
export default function prelisten() {
  assertConsoleConfiguration(process.env);
}

/** Retired local provisioning entrypoint. Never reads or changes private state. */
console.error(
  'Local/demo provisioning has been retired. Configure the production identity and database settings in deploy/README.md, then use npm start for the service and npm run start:console (or npm run dev) for the authenticated console. Existing private files and databases are preserved.',
);
process.exitCode = 1;

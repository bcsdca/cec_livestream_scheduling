# CEC Livestream Scheduling

This project automates the scheduling of weekly livestreams for the English, Mandarin, and Cantonese congregations of CEC.

## Features

1. Automated Scheduling
  Automatically schedules livestreams for all three congregations (English, Mandarin, and Cantonese) based on a predefined schedule.
  Current setup: All streams are scheduled for 9:30 PM every Friday.
  
2. Multi-Congregation Support
  Supports scheduling for English, Mandarin, and Cantonese services.

3. Configurable
  Settings and credentials are managed through configuration files (excluded from the repository for security).

4. Report
  It will send email to Bill Chu, Jason Tong, Michael Kuo for successful or any failure msg during livestream scheduling. 


- TBD
  setting up the CEC youTube hyperlink for all 3 services youTube link, via Word Press REST API

## Usage

1. using node.js

2. Install the required dependencies by running `npm install` in your project directory.

2. Adjust/Create configuration files such as `config.mjs` and `credentials.json` as needed.
   Please keep these files out of the repository to protect sensitive information.

3. Run the main scheduling script using the command `node schedule-all-streams.mjs`.

4. The scheduling script is currently run on a Google Cloud VM.
   You can set up a cron job on the VM to automatically trigger the script at the desired times.
   The VM instance can be managed via Google Cloud Run to start or stop as needed.

## Notes

- Sensitive files like `credentials.json`, `conig.mls` and `token.json` are ignored by `.gitignore` and must **not** be pushed to GitHub.
- Manual scheduling is required for special events.
- Alternative methods to run the script, such as using a Linux environment on a local PC or laptop, are possible.
- Ideally, livestream scheduling could be better handled using Google Apps Script within a Google Workspace environment.
  However, this approach requires the CEC YouTube owner account credentials(login/passwd)

## License

MIT


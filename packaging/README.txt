OnPrem Transformation Planner  v{{VERSION}}
=========================================

Self-contained package. Needs only Node.js (22.13+ or 24 LTS) on the server:
no internet access, no "npm install", no GitHub.

START
  Windows:      double-click start.bat        (port 8080)
                or: start.bat 9000            (any port)
  Linux/macOS:  ./start.sh 9000

  Then browse to http://<server-name>:<port>  (everyone on the network uses the same URL)

WHAT'S IN THE FOLDER
  server.mjs    the application server (API + web app, all libraries bundled)
  app\          the web pages
  data\         created on first start - footprint.db holds ALL decisions, history,
                settings and every uploaded VMInfo file. BACK THIS FILE UP
                (it is a single self-contained file - safe to copy while running).

FIRST USE
  1. Open the URL, enter your name (recorded against your changes).
  2. Inventory Updates -> upload the latest VMInfo .xlsx.
  3. Application Planner -> set each application's treatment and target FY quarter.
  4. Upload each new VMInfo export the same way - decisions carry over automatically
     (matched on Application_Primary). Renamed applications can be re-linked there.

UPGRADING
  Stop the server, replace server.mjs and the app\ folder with the new version,
  keep the data\ folder, start again.

RUN PERMANENTLY (Windows)
  Task Scheduler -> Create Task -> "Run whether user is logged on or not",
  Trigger: At startup, Action: start.bat 8080, "Start in": this folder.
  Allow the port through Windows Firewall if prompted.

OPTIONS
  start.bat <port>                  port (default 8080)
  node server.mjs --port 8080 --host 0.0.0.0 --db D:\footprint\footprint.db

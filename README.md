# AI Eye-Tracking Live Interview Proctoring System

An automated in-browser video proctoring platform designed for live candidate interviews. The system uses real-time computer vision to track eye gaze and head orientation, ensuring candidates look at their laptop screen. **If a candidate looks away from the laptop more than 15 times, the system automatically terminates and closes the interview.**

## Core Features

- **Real-Time Webcam Gaze Tracking**: MediaPipe FaceMesh tracks face landmarks, head yaw/pitch, and iris centers directly in the browser at 60 FPS without local Python vision installation.
- **Intelligent Laptop Camera Selection**: Auto-detects and prioritizes the laptop's built-in webcam over virtual/connected phone cameras (e.g. Phone Link, DroidCam, Iriun). Includes a quick camera selector dropdown to switch video input on the fly.
- **Live Screen Sharing Proctoring**: Requires continuous full-screen sharing via the browser's Screen Capture API (`getDisplayMedia`). Monitors live screen feed and immediately triggers a proctor warning if screen sharing is stopped.
- **Sustained Off-Screen Detection**: Detects when candidate looks away to the left, right, down at a mobile phone/desk notes, up, or leaves the webcam view.
- **Strict 15-Warning Limit**: Prominent on-screen warning counter (`Warnings: X / 15`) with visual and audio alerts.
- **Automatic Interview Closure (Terminated on 15th Violation)**: As soon as the candidate reaches 15 look-away warnings:
  - Shuts down webcam stream immediately.
  - Automatically triggers server-side termination API.
  - Locks the screen with an unclosable termination modal displaying the exact audit log with timestamps.
  - Prevents further question submissions.
- **Proctor Audit Dashboard**: Live session monitor showing all candidate statuses (In Progress, Terminated, Completed), active screen share indicators, and chronological timestamps of every look-away violation.


## Technology Stack

- **Backend**: Python Flask
- **Database**: SQLite with SQLAlchemy ORM
- **Frontend**: HTML5, CSS3, JavaScript (Bootstrap 5)
- **Computer Vision**: Google MediaPipe FaceMesh & Camera Utils (Client-side WebAssembly/WebGL)

## Installation & Setup

### Prerequisites
- Python 3.8 or higher
- Modern web browser with webcam access (Chrome, Edge, Firefox)

### Setup Steps

1. **Navigate to the project directory**
   ```bash
   cd stroke
   ```

2. **Create a virtual environment (optional but recommended)**
   ```bash
   python -m venv venv
   ```
   - Windows:
     ```bash
     venv\Scripts\activate
     ```
   - macOS/Linux:
     ```bash
     source venv/bin/activate
     ```

3. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the application**
   ```bash
   python app.py
   ```

5. **Access the application**
   Open your browser and navigate to: `http://localhost:5000`

## Application Structure

```
stroke/
├── app.py                      # Main Flask application & proctoring routes
├── models/
│   └── database.py            # SQLite models (InterviewSession, ViolationLog)
├── templates/
│   ├── base.html              # Common layout & navigation
│   ├── index.html             # Landing portal & quick actions
│   ├── interview_start.html   # Candidate registration form & rules policy
│   ├── interview_room.html    # Live webcam interview screen & auto-closure modal
│   └── proctor_dashboard.html # Proctor real-time audit dashboard
├── static/
│   ├── css/
│   │   ├── style.css          # Common UI styles
│   │   └── interview.css      # Interview room & proctoring styles
│   └── js/
│       ├── main.js            # General UI helpers
│       └── interview_tracker.js # MediaPipe gaze & head tracking engine
└── requirements.txt           # Minimal Python dependencies
```

## User Workflows

1. **Candidate Interview Flow**:
   - Go to `http://localhost:5000/interview/start`
   - Enter name, email, and position applied.
   - Accept proctoring terms and launch the live room.
   - The browser prompts for webcam access.
   - Answer technical interview questions while maintaining visual contact with the laptop screen.
   - If candidate looks away > 15 times, the interview auto-closes and locks immediately.

2. **Proctor Audit Flow**:
   - Go to `http://localhost:5000/interview/proctor`
   - Monitor live candidate sessions in real time.
   - View violation breakdown, timestamps, and reason for termination.

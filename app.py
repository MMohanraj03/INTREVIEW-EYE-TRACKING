from flask import Flask, render_template, request, redirect, url_for, session, flash, jsonify
from models.database import db, InterviewSession, ViolationLog, InterviewQuestion
import os
import json
import secrets
from datetime import datetime

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),
    static_folder=os.path.join(BASE_DIR, 'static')
)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')

# Vercel / serverless environment support (ephemeral /tmp SQLite)
if os.environ.get('VERCEL'):
    db_file = '/tmp/interview_proctor.db'
    seed_db = os.path.join(BASE_DIR, 'instance', 'interview_proctor.db')
    if os.path.exists(seed_db) and not os.path.exists(db_file):
        try:
            import shutil
            shutil.copyfile(seed_db, db_file)
        except Exception:
            pass
    app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_file}'
else:
    app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///interview_proctor.db')

app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)

ADMIN_PASSCODE = os.environ.get('ADMIN_PASSCODE', 'admin123')

def check_is_admin():
    """Verify if the current request is from an authenticated Admin / Interviewer."""
    if session.get('is_admin') is True:
        return True
    auth_header = request.headers.get('X-Admin-Key')
    if auth_header and auth_header == ADMIN_PASSCODE:
        return True
    key = request.args.get('admin_key') or request.form.get('admin_key')
    if key and key == ADMIN_PASSCODE:
        return True
    json_data = request.get_json(silent=True)
    if json_data and isinstance(json_data, dict) and json_data.get('admin_key') == ADMIN_PASSCODE:
        return True
    return False

def generate_meeting_code():
    p1 = secrets.token_hex(2).upper()
    p2 = secrets.token_hex(2).upper()
    return f"MEET-{p1}-{p2}"

# Initialize database
with app.app_context():
    try:
        db.create_all()
    except Exception as e:
        print(f"Database init warning: {e}")

SAMPLE_QUESTIONS = [
    {
        "id": 1,
        "title": "Data Structures & Problem Solving",
        "category": "Computer Science",
        "question": "Explain how a Hash Map handles collisions under the hood. Contrast Separate Chaining with Open Addressing (Linear Probing vs Quadratic Probing), noting worst-case time complexities."
    },
    {
        "id": 2,
        "title": "System Design & Architecture",
        "category": "System Design",
        "question": "How would you design a scalable real-time notification service that handles 100,000 concurrent WebSocket connections with low latency and reliable message delivery?"
    },
    {
        "id": 3,
        "title": "Concurrency & Memory Management",
        "category": "Operating Systems",
        "question": "What is the difference between concurrency and parallelism? How do race conditions occur, and how do mutexes, semaphores, and atomic operations prevent data corruption?"
    },
    {
        "id": 4,
        "title": "Web Performance & Computer Vision",
        "category": "Web & CV",
        "question": "How does client-side computer vision (such as MediaPipe FaceMesh) process video frames at 60 FPS in the browser without blocking the UI main thread?"
    }
]

def get_or_seed_questions():
    """Retrieve active questions from database, seeding defaults if empty."""
    questions = InterviewQuestion.query.filter_by(is_active=True).order_by(InterviewQuestion.order_num.asc(), InterviewQuestion.id.asc()).all()
    if not questions:
        for sq in SAMPLE_QUESTIONS:
            q = InterviewQuestion(
                title=sq['title'],
                question=sq['question'],
                category=sq.get('category', 'Technical'),
                order_num=sq['id'],
                is_active=True
            )
            db.session.add(q)
        db.session.commit()
        questions = InterviewQuestion.query.filter_by(is_active=True).order_by(InterviewQuestion.order_num.asc(), InterviewQuestion.id.asc()).all()
    return questions


@app.route('/')
def index():
    return render_template('index.html')

@app.route('/interview')
def interview_entry():
    # Find latest active session or create a default candidate session
    session_obj = InterviewSession.query.filter_by(status='in_progress').order_by(InterviewSession.created_at.desc()).first()
    if not session_obj:
        code = generate_meeting_code()
        session_obj = InterviewSession(
            candidate_name="Candidate " + datetime.utcnow().strftime('%M%S'),
            candidate_email="candidate@interview.local",
            role_applied="Full-Stack AI Software Engineer",
            max_violations=15,
            meeting_code=code,
            meeting_link=f"{request.host_url}interview/join/{code}",
            scheduled_date=datetime.utcnow().strftime('%Y-%m-%d'),
            scheduled_time=datetime.utcnow().strftime('%H:%M'),
            scheduled_datetime=datetime.utcnow(),
            status='in_progress'
        )
        db.session.add(session_obj)
        db.session.commit()
    return redirect(url_for('interview_room', session_id=session_obj.id))

@app.route('/interview/start', methods=['GET', 'POST'])
def interview_start():
    if request.method == 'POST':
        name = request.form.get('candidate_name', '').strip() or 'Candidate'
        email = request.form.get('candidate_email', '').strip() or 'candidate@interview.local'
        role = request.form.get('role_applied', '').strip() or 'Software Engineer'
        max_viol = int(request.form.get('max_violations', 15))
        
        code = generate_meeting_code()
        meeting_link = f"{request.host_url}interview/join/{code}"
        
        session_obj = InterviewSession(
            candidate_name=name,
            candidate_email=email,
            role_applied=role,
            max_violations=max_viol,
            status='in_progress',
            meeting_code=code,
            meeting_link=meeting_link,
            scheduled_date=datetime.utcnow().strftime('%Y-%m-%d'),
            scheduled_time=datetime.utcnow().strftime('%H:%M'),
            scheduled_datetime=datetime.utcnow()
        )
        db.session.add(session_obj)
        db.session.commit()
        return redirect(url_for('interview_room', session_id=session_obj.id))
    
    return render_template('interview_start.html')

@app.route('/interview/schedule', methods=['GET', 'POST'])
def interview_schedule():
    if request.method == 'POST':
        name = request.form.get('candidate_name', '').strip() or 'Candidate'
        email = request.form.get('candidate_email', '').strip() or 'candidate@interview.local'
        role = request.form.get('role_applied', '').strip() or 'Software Engineer'
        sched_date = request.form.get('scheduled_date', '').strip()
        sched_time = request.form.get('scheduled_time', '').strip()
        max_viol = int(request.form.get('max_violations', 15))
        
        if not sched_date:
            sched_date = datetime.utcnow().strftime('%Y-%m-%d')
        if not sched_time:
            sched_time = '10:00'
            
        try:
            sched_dt = datetime.strptime(f"{sched_date} {sched_time}", '%Y-%m-%d %H:%M')
        except Exception:
            sched_dt = datetime.utcnow()
            
        code = generate_meeting_code()
        meeting_link = f"{request.host_url}interview/join/{code}"
        
        session_obj = InterviewSession(
            candidate_name=name,
            candidate_email=email,
            role_applied=role,
            max_violations=max_viol,
            status='scheduled',
            meeting_code=code,
            meeting_link=meeting_link,
            scheduled_date=sched_date,
            scheduled_time=sched_time,
            scheduled_datetime=sched_dt
        )
        db.session.add(session_obj)
        db.session.commit()
        
        return redirect(url_for('interview_scheduled_confirmation', meeting_code=code))
        
    return render_template('interview_schedule.html')

@app.route('/interview/scheduled/<meeting_code>')
def interview_scheduled_confirmation(meeting_code):
    session_obj = InterviewSession.query.filter_by(meeting_code=meeting_code).first_or_404()
    return render_template('meeting_confirmed.html', session=session_obj)

@app.route('/interview/join/<meeting_code>')
def interview_join(meeting_code):
    session_obj = InterviewSession.query.filter_by(meeting_code=meeting_code).first()
    if not session_obj and meeting_code.isdigit():
        session_obj = InterviewSession.query.get(int(meeting_code))
    if not session_obj:
        flash(f'Meeting code "{meeting_code}" was not found. Please verify the link.', 'danger')
        return redirect(url_for('index'))
        
    if session_obj.status == 'terminated':
        flash('This interview session has reached the 15-warning limit and is terminated.', 'danger')
        return redirect(url_for('interview_room', session_id=session_obj.id))
        
    return render_template('interview_lobby.html', session=session_obj)

@app.route('/interview/join-code', methods=['POST'])
def interview_join_code():
    raw_code = request.form.get('meeting_code', '').strip()
    clean_code = raw_code.rstrip('/').split('/')[-1].upper()
    if not clean_code:
        flash('Please enter a valid meeting code or link.', 'warning')
        return redirect(url_for('index'))
    return redirect(url_for('interview_join', meeting_code=clean_code))

@app.route('/interview/enter/<int:session_id>', methods=['POST'])
def interview_enter(session_id):
    session_obj = InterviewSession.query.get_or_404(session_id)
    if session_obj.status == 'scheduled':
        session_obj.status = 'in_progress'
        db.session.commit()
    return redirect(url_for('interview_room', session_id=session_obj.id))

@app.route('/interview/<int:session_id>')
def interview_room(session_id):
    session_obj = InterviewSession.query.get_or_404(session_id)
    questions = get_or_seed_questions()
    
    current_q = None
    if session_obj.current_question_id:
        current_q = InterviewQuestion.query.get(session_obj.current_question_id)
    if not current_q and questions:
        current_q = questions[0]
        session_obj.current_question_id = current_q.id
        db.session.commit()
        
    return render_template('interview_room.html', 
                           interview=session_obj, 
                           questions=questions,
                           current_question=current_q,
                           is_admin=check_is_admin(),
                           max_violations=session_obj.max_violations)

@app.route('/api/interview/<int:session_id>/violation', methods=['POST'])
def api_interview_violation(session_id):
    session_obj = InterviewSession.query.get_or_404(session_id)
    
    if session_obj.status == 'terminated':
        return jsonify({
            'status': 'terminated',
            'violations_count': session_obj.violations_count,
            'max_violations': session_obj.max_violations,
            'message': 'Interview is already terminated.'
        })
    
    data = request.get_json(silent=True) or request.form
    violation_type = data.get('violation_type', 'looked_away_general')
    description = data.get('description', 'Candidate looked away from laptop screen')
    
    session_obj.violations_count += 1
    
    # Create violation log
    log = ViolationLog(
        session_id=session_obj.id,
        violation_number=session_obj.violations_count,
        violation_type=violation_type,
        description=description
    )
    db.session.add(log)
    
    # Check if 15 violations reached
    if session_obj.violations_count >= session_obj.max_violations:
        session_obj.status = 'terminated'
        session_obj.termination_reason = f'Candidate looked away from laptop more than {session_obj.max_violations} times. Automated Proctoring Termination.'
        session_obj.ended_at = datetime.utcnow()
        db.session.commit()
        
        return jsonify({
            'status': 'terminated',
            'violations_count': session_obj.violations_count,
            'max_violations': session_obj.max_violations,
            'remaining': 0,
            'message': f'Interview automatically closed! Exceeded {session_obj.max_violations} look-away warnings.',
            'terminated': True
        })
    
    db.session.commit()
    return jsonify({
        'status': 'warning',
        'violations_count': session_obj.violations_count,
        'max_violations': session_obj.max_violations,
        'remaining': session_obj.max_violations - session_obj.violations_count,
        'message': f'Warning {session_obj.violations_count}/{session_obj.max_violations}: Look back at laptop screen!',
        'terminated': False
    })

@app.route('/api/interview/<int:session_id>/terminate', methods=['POST'])
def api_interview_terminate(session_id):
    session_obj = InterviewSession.query.get_or_404(session_id)
    session_obj.status = 'terminated'
    if not session_obj.termination_reason:
        session_obj.termination_reason = f'Automatically closed: Candidate exceeded {session_obj.max_violations} off-screen gaze violations.'
    session_obj.ended_at = datetime.utcnow()
    db.session.commit()
    return jsonify({'success': True, 'status': 'terminated'})

@app.route('/api/interview/<int:session_id>/submit', methods=['POST'])
def api_interview_submit(session_id):
    session_obj = InterviewSession.query.get_or_404(session_id)
    if session_obj.status != 'terminated':
        session_obj.status = 'completed'
        session_obj.ended_at = datetime.utcnow()
        data = request.get_json(silent=True) or request.form
        if data.get('answers'):
            session_obj.answers = json.dumps(data.get('answers'))
        db.session.commit()
    return jsonify({'success': True, 'status': session_obj.status})

@app.route('/api/interview/<int:session_id>/screenshare', methods=['POST'])
def api_interview_screenshare(session_id):
    session_obj = InterviewSession.query.get_or_404(session_id)
    data = request.get_json(silent=True) or request.form
    is_active = bool(data.get('active', False))
    session_obj.screen_sharing_active = is_active
    
    # If candidate disconnected/stopped screen sharing, record a proctor violation warning
    if not is_active and data.get('log_warning', False) and session_obj.status == 'in_progress':
        session_obj.violations_count += 1
        log = ViolationLog(
            session_id=session_obj.id,
            violation_number=session_obj.violations_count,
            violation_type='screenshare_stopped',
            description='Candidate stopped or disconnected live screen sharing'
        )
        db.session.add(log)
        if session_obj.violations_count >= session_obj.max_violations:
            session_obj.status = 'terminated'
            session_obj.termination_reason = 'Candidate stopped sharing screen and exceeded 15 allowable warnings.'
            session_obj.ended_at = datetime.utcnow()
    
    db.session.commit()
    return jsonify({
        'success': True,
        'screen_sharing_active': session_obj.screen_sharing_active,
        'violations_count': session_obj.violations_count,
        'status': session_obj.status
    })

# ==============================================================
# ADMIN AUTHENTICATION & ACCESS CONTROL
# ==========================================
@app.route('/api/admin/login', methods=['POST'])
def api_admin_login():
    data = request.get_json(silent=True) or request.form
    passcode = (data.get('passcode') or data.get('admin_key') or '').strip()
    if passcode == ADMIN_PASSCODE:
        session['is_admin'] = True
        return jsonify({'success': True, 'is_admin': True, 'message': 'Admin mode authenticated successfully.'})
    return jsonify({'success': False, 'is_admin': False, 'message': 'Incorrect admin passcode. Access denied.'}), 401

@app.route('/api/admin/logout', methods=['POST'])
def api_admin_logout():
    session['is_admin'] = False
    return jsonify({'success': True, 'is_admin': False, 'message': 'Admin mode logged out.'})

@app.route('/api/admin/status')
def api_admin_status():
    return jsonify({'is_admin': check_is_admin()})

# ==============================================================
# QUESTION MANAGEMENT: ONLY ADMIN CAN CHANGE THE QUESTION
# ==============================================================
@app.route('/api/interview/<int:session_id>/current_question', methods=['GET'])
def api_get_current_question(session_id):
    session_obj = InterviewSession.query.get_or_404(session_id)
    questions = get_or_seed_questions()
    
    current_q = None
    if session_obj.current_question_id:
        current_q = InterviewQuestion.query.get(session_obj.current_question_id)
    if not current_q and questions:
        current_q = questions[0]
        session_obj.current_question_id = current_q.id
        db.session.commit()
        
    return jsonify({
        'session_id': session_obj.id,
        'current_question_id': current_q.id if current_q else None,
        'current_question': current_q.to_dict() if current_q else None,
        'questions': [q.to_dict() for q in questions],
        'is_admin': check_is_admin()
    })

@app.route('/api/interview/<int:session_id>/change_question', methods=['POST'])
def api_interview_change_question(session_id):
    """
    CRITICAL ACCESS CONTROL:
    Only authenticated Admin / Interviewer can change the active question!
    Candidates attempting to change question receive 403 Forbidden.
    """
    if not check_is_admin():
        return jsonify({
            'success': False,
            'error': 'Access Denied: Only Admin can change the question. Candidates cannot modify or switch questions.',
            'is_admin': False
        }), 403

    session_obj = InterviewSession.query.get_or_404(session_id)
    data = request.get_json(silent=True) or request.form
    questions = get_or_seed_questions()
    
    target_q_id = data.get('question_id')
    direction = data.get('direction')  # 'next' or 'prev'
    
    if direction and questions:
        q_ids = [q.id for q in questions]
        current_idx = q_ids.index(session_obj.current_question_id) if session_obj.current_question_id in q_ids else 0
        if direction == 'next':
            new_idx = min(current_idx + 1, len(q_ids) - 1)
        else:
            new_idx = max(current_idx - 1, 0)
        target_q_id = q_ids[new_idx]
        
    if not target_q_id:
        return jsonify({'success': False, 'error': 'No question specified.'}), 400
        
    question_obj = InterviewQuestion.query.get(int(target_q_id))
    if not question_obj:
        return jsonify({'success': False, 'error': 'Question not found.'}), 404
        
    session_obj.current_question_id = question_obj.id
    db.session.commit()
    
    return jsonify({
        'success': True,
        'message': f'Active question successfully changed to Question #{question_obj.id} by Admin.',
        'current_question_id': question_obj.id,
        'question': question_obj.to_dict(),
        'is_admin': True
    })

# ==============================================================
# ADMIN QUESTION BANK CRUD (ADMIN ONLY)
# ==============================================================
@app.route('/api/admin/questions', methods=['GET'])
def api_admin_get_questions():
    questions = get_or_seed_questions()
    return jsonify({
        'questions': [q.to_dict() for q in questions],
        'is_admin': check_is_admin()
    })

@app.route('/api/admin/questions/add', methods=['POST'])
def api_admin_add_question():
    if not check_is_admin():
        return jsonify({'success': False, 'error': 'Unauthorized: Only Admin can add questions.'}), 403
        
    data = request.get_json(silent=True) or request.form
    title = (data.get('title') or '').strip()
    question_text = (data.get('question') or '').strip()
    category = (data.get('category') or 'Technical').strip()
    
    if not title or not question_text:
        return jsonify({'success': False, 'error': 'Title and Question text are required.'}), 400
        
    count = InterviewQuestion.query.count()
    new_q = InterviewQuestion(
        title=title,
        question=question_text,
        category=category,
        order_num=count + 1,
        is_active=True
    )
    db.session.add(new_q)
    db.session.commit()
    return jsonify({
        'success': True,
        'question': new_q.to_dict(),
        'message': f'New question "{title}" added to question bank by Admin.'
    })

@app.route('/api/admin/questions/<int:question_id>/edit', methods=['POST'])
def api_admin_edit_question(question_id):
    if not check_is_admin():
        return jsonify({'success': False, 'error': 'Unauthorized: Only Admin can edit questions.'}), 403
        
    q = InterviewQuestion.query.get_or_404(question_id)
    data = request.get_json(silent=True) or request.form
    if data.get('title'):
        q.title = data.get('title').strip()
    if data.get('question'):
        q.question = data.get('question').strip()
    if data.get('category'):
        q.category = data.get('category').strip()
    db.session.commit()
    return jsonify({
        'success': True,
        'question': q.to_dict(),
        'message': f'Question #{question_id} updated successfully by Admin.'
    })

@app.route('/api/admin/questions/<int:question_id>/delete', methods=['POST'])
def api_admin_delete_question(question_id):
    if not check_is_admin():
        return jsonify({'success': False, 'error': 'Unauthorized: Only Admin can delete questions.'}), 403
        
    q = InterviewQuestion.query.get_or_404(question_id)
    db.session.delete(q)
    db.session.commit()
    return jsonify({
        'success': True,
        'message': f'Question #{question_id} removed from question bank by Admin.'
    })

@app.route('/interview/proctor')
def proctor_dashboard():
    sessions = InterviewSession.query.order_by(InterviewSession.created_at.desc()).all()
    questions = get_or_seed_questions()
    total_count = len(sessions)
    terminated_count = sum(1 for s in sessions if s.status == 'terminated')
    active_count = sum(1 for s in sessions if s.status == 'in_progress')
    completed_count = sum(1 for s in sessions if s.status == 'completed')
    scheduled_count = sum(1 for s in sessions if s.status == 'scheduled')
    
    return render_template('proctor_dashboard.html',
                           sessions=sessions,
                           questions=questions,
                           is_admin=check_is_admin(),
                           total_count=total_count,
                           terminated_count=terminated_count,
                           active_count=active_count,
                           completed_count=completed_count,
                           scheduled_count=scheduled_count)


@app.route('/api/interview/proctor/live')
def api_proctor_live():
    sessions = InterviewSession.query.order_by(InterviewSession.created_at.desc()).limit(25).all()
    return jsonify({
        'sessions': [s.to_dict() for s in sessions]
    })

@app.route('/interview/session/<int:session_id>/reset', methods=['POST'])
def reset_interview_session(session_id):
    session_obj = InterviewSession.query.get_or_404(session_id)
    session_obj.status = 'in_progress'
    session_obj.violations_count = 0
    session_obj.termination_reason = None
    session_obj.ended_at = None
    session_obj.screen_sharing_active = False
    ViolationLog.query.filter_by(session_id=session_id).delete()
    db.session.commit()
    flash('Interview session reset successfully. Returned to Home Screen.', 'success')
    return redirect(url_for('index'))


@app.route('/api/index.py')
def vercel_index():
    return render_template('index.html')

@app.errorhandler(404)
def handle_404(e):
    if request.path in ('/', '/api/index.py', '/index'):
        return render_template('index.html')
    return render_template('index.html'), 404

# Legacy Route Fallbacks (Redirect any old stroke/patient/doctor URLs to Interview Proctoring)
@app.route('/patient/dashboard')
@app.route('/patient/history')
@app.route('/patient/predict')
@app.route('/patient/communicator')
@app.route('/login')
@app.route('/register')
def legacy_patient_redirect():
    return redirect(url_for('interview_start'))

@app.route('/doctor/dashboard')
@app.route('/doctor/prediction/<path:subpath>')
def legacy_doctor_redirect(**kwargs):
    return redirect(url_for('proctor_dashboard'))

if __name__ == '__main__':
    # Binding to 0.0.0.0 allows connections from 127.0.0.1, localhost, and local network IPs
    app.run(host='0.0.0.0', port=5000, debug=True)


from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

db = SQLAlchemy()

class InterviewSession(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    candidate_name = db.Column(db.String(100), nullable=False)
    candidate_email = db.Column(db.String(120), nullable=False)
    role_applied = db.Column(db.String(100), default='Software Engineer')
    status = db.Column(db.String(30), default='in_progress')  # 'scheduled', 'in_progress', 'completed', 'terminated'
    meeting_code = db.Column(db.String(32), unique=True, index=True, nullable=True)
    meeting_link = db.Column(db.String(255), nullable=True)
    scheduled_date = db.Column(db.String(30), nullable=True)
    scheduled_time = db.Column(db.String(20), nullable=True)
    scheduled_datetime = db.Column(db.DateTime, nullable=True)
    violations_count = db.Column(db.Integer, default=0)
    max_violations = db.Column(db.Integer, default=15)
    termination_reason = db.Column(db.String(255), nullable=True)
    screen_sharing_active = db.Column(db.Boolean, default=False)
    answers = db.Column(db.Text, nullable=True)
    current_question_id = db.Column(db.Integer, default=1)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    ended_at = db.Column(db.DateTime, nullable=True)
    
    violations = db.relationship('ViolationLog', backref='session', cascade='all, delete-orphan', lazy=True, order_by='ViolationLog.timestamp.desc()')
    
    def to_dict(self):
        return {
            'id': self.id,
            'candidate_name': self.candidate_name,
            'candidate_email': self.candidate_email,
            'role_applied': self.role_applied,
            'status': self.status,
            'meeting_code': self.meeting_code,
            'meeting_link': self.meeting_link,
            'scheduled_date': self.scheduled_date,
            'scheduled_time': self.scheduled_time,
            'scheduled_datetime': self.scheduled_datetime.strftime('%Y-%m-%d %H:%M:%S') if self.scheduled_datetime else None,
            'violations_count': self.violations_count,
            'max_violations': self.max_violations,
            'termination_reason': self.termination_reason,
            'screen_sharing_active': self.screen_sharing_active,
            'current_question_id': self.current_question_id or 1,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'ended_at': self.ended_at.strftime('%Y-%m-%d %H:%M:%S') if self.ended_at else None,
            'violations': [v.to_dict() for v in self.violations]
        }
    
    def __repr__(self):
        return f'<InterviewSession {self.id} - {self.candidate_name} ({self.status})>'

class InterviewQuestion(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(150), nullable=False)
    question = db.Column(db.Text, nullable=False)
    category = db.Column(db.String(100), default='Technical')
    order_num = db.Column(db.Integer, default=1)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'title': self.title,
            'question': self.question,
            'category': self.category,
            'order_num': self.order_num,
            'is_active': self.is_active,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S') if self.created_at else None
        }
    
    def __repr__(self):
        return f'<InterviewQuestion #{self.id}: {self.title}>'

class ViolationLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer, db.ForeignKey('interview_session.id'), nullable=False)
    violation_number = db.Column(db.Integer, nullable=False)
    violation_type = db.Column(db.String(50), nullable=False)
    description = db.Column(db.String(255), nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'session_id': self.session_id,
            'violation_number': self.violation_number,
            'violation_type': self.violation_type,
            'description': self.description,
            'timestamp': self.timestamp.strftime('%H:%M:%S')
        }
    
    def __repr__(self):
        return f'<ViolationLog #{self.violation_number} in Session {self.session_id}: {self.violation_type}>'


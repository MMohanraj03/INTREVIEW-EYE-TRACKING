import sys
import os

# Add root folder to sys.path so app and models can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app

class VercelPathFixMiddleware:
    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        matched_path = (
            environ.get('HTTP_X_MATCHED_PATH')
            or environ.get('HTTP_X_VERCEL_MATCHED_PATH')
            or environ.get('HTTP_X_FORWARDED_URI')
        )
        if matched_path:
            # Strip query string if present in matched_path
            path_only = matched_path.split('?')[0]
            environ['PATH_INFO'] = path_only
        elif environ.get('PATH_INFO') == '/api/index.py':
            environ['PATH_INFO'] = '/'
        elif environ.get('PATH_INFO', '').startswith('/api/index.py'):
            environ['PATH_INFO'] = environ['PATH_INFO'][len('/api/index.py'):] or '/'

        return self.wsgi_app(environ, start_response)

app.wsgi_app = VercelPathFixMiddleware(app.wsgi_app)

import sys
import os

# Add root folder to sys.path so app and models can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app

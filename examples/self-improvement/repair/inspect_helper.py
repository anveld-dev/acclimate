#!/usr/bin/env python3
"""Static preflight for a pure, read-only skill resource. Never executes the submission."""
import ast
import json
import sys

errors = []
source = sys.stdin.read()
try:
    tree = ast.parse(source, feature_version=(3, 9))
    allowed = {'json', 'sys', 'pathlib', 'collections', 'math'}
    dangerous = {'eval', 'exec', 'compile', '__import__', 'getattr', 'setattr'}
    writes = {'write', 'write_text', 'write_bytes', 'unlink', 'mkdir', 'rename', 'replace', 'rmdir', 'touch', 'chmod', 'symlink_to', 'hardlink_to'}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name.split('.')[0] not in allowed for alias in node.names):
                errors.append('Only json/sys/pathlib/collections/math imports are allowed')
        if isinstance(node, ast.ImportFrom) and (node.level or (node.module or '').split('.')[0] not in allowed):
            errors.append('Unsupported import')
        if isinstance(node, ast.Attribute) and node.attr.startswith('__'):
            errors.append('Dunder traversal is not allowed')
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and (node.value.startswith('/') and len(node.value)>1 or node.value.startswith('~/')):
            errors.append('Absolute or home-relative paths are not allowed')
        if isinstance(node, ast.Call):
            fn = node.func
            name = fn.id if isinstance(fn, ast.Name) else fn.attr if isinstance(fn, ast.Attribute) else None
            if name in dangerous or (isinstance(fn, ast.Attribute) and name in writes):
                errors.append('Dynamic execution or filesystem mutation is not allowed')
            if name == 'open':
                position = 0 if isinstance(fn, ast.Attribute) else 1
                mode = next((k.value for k in node.keywords if k.arg == 'mode'), node.args[position] if len(node.args) > position else None)
                if mode is not None and (not isinstance(mode, ast.Constant) or mode.value not in ('r', 'rt', 'rb')):
                    errors.append('Files may be opened only for reading')
except SyntaxError as error:
    errors.append(f'Python 3.9 syntax error at line {error.lineno}: {error.msg}')
print(json.dumps({'valid': not errors, 'errors': list(dict.fromkeys(errors))}))

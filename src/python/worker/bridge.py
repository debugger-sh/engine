import bdb, sys, json, os

CONTINUE   = 0
STEP_OVER  = 1
STEP_INTO  = 2
STEP_OUT   = 3

MAX_REPR = 120
MAX_CHILDREN = 50
MAX_DEPTH = 3

def truncate_repr(value):
    s = repr(value)
    if len(s) <= MAX_REPR:
        return s
    return s[:MAX_REPR - 1] + '…'

def format_local(name, value, depth=0):
    if depth >= MAX_DEPTH:
        return {"name": name, "value": truncate_repr(value), "children": []}

    if isinstance(value, list):
        n = len(value)
        children = [
            format_local(f'[{i}]', item, depth + 1)
            for i, item in enumerate(value[:MAX_CHILDREN])
        ]
        if n > MAX_CHILDREN:
            children.append({
                "name": "…",
                "value": f"{n - MAX_CHILDREN} more",
                "children": [],
            })
        return {"name": name, "value": f"list[{n}]", "children": children}

    if isinstance(value, tuple):
        n = len(value)
        children = [
            format_local(f'[{i}]', item, depth + 1)
            for i, item in enumerate(value[:MAX_CHILDREN])
        ]
        if n > MAX_CHILDREN:
            children.append({
                "name": "…",
                "value": f"{n - MAX_CHILDREN} more",
                "children": [],
            })
        return {"name": name, "value": f"tuple[{n}]", "children": children}

    if isinstance(value, dict):
        n = len(value)
        children = []
        for i, (key, item) in enumerate(value.items()):
            if i >= MAX_CHILDREN:
                children.append({
                    "name": "…",
                    "value": f"{n - MAX_CHILDREN} more",
                    "children": [],
                })
                break
            key_name = key if isinstance(key, str) else repr(key)
            children.append(format_local(key_name, item, depth + 1))
        return {"name": name, "value": f"dict[{n}]", "children": children}

    return {"name": name, "value": truncate_repr(value), "children": []}

class DapBridge(bdb.Bdb):
    def __init__(self):
        super().__init__()
        self._dbg = open('/__debug__', 'r+b', buffering=0)
        self._stepping = False

    def _read_response(self):
        data = b''
        while True:
            chunk = self._dbg.read(512)
            if not chunk:
                break
            data += chunk
        if not data:
            return None
        return json.loads(data.decode())

    def _apply_config(self, resp):
        self._apply_breakpoints(resp.get("breakpoints", {}))
        cmd = resp["cmd"]
        if cmd == CONTINUE:
            self._stepping = False
        elif cmd in (STEP_OVER, STEP_INTO, STEP_OUT):
            self._stepping = True

    def _dispatch(self, resp, frame):
        self._apply_config(resp)
        cmd = resp["cmd"]

        if cmd == CONTINUE:
            self.set_continue()
        elif cmd == STEP_OVER:
            self.set_next(frame)
        elif cmd == STEP_INTO:
            self.set_step()
        elif cmd == STEP_OUT:
            self.set_return(frame)

    def consume_initial_config(self):
        resp = self._read_response()
        if resp is None:
            return
        self._apply_config(resp)

    def _apply_breakpoints(self, breakpoints):
        self.clear_all_breaks()
        for path, lines in breakpoints.items():
            for line in lines:
                self.set_break(path, line)

    def user_line(self, frame):
        if not self._stepping and not self.break_here(frame):
            return
        self._pause(frame)

    def user_exception(self, frame, exc_info):
        self._pause(frame)

    def _pause(self, frame):
        stack = []
        f = frame
        while f is not None:
            name = f.f_code.co_name
            path = f.f_code.co_filename
            if name == '<module>' and path == '/main.py':
                # Module scope — not the same as a function named `main`.
                display = '__main__'
            else:
                display = name
            stack.append({
                "file": path,
                "line": f.f_lineno,
                "function": display,
                "user": f.f_code.co_filename == '/main.py',
                "locals": [
                    format_local(name, value)
                    for name, value in f.f_locals.items()
                ],
            })
            f = f.f_back

        data = json.dumps({
            "reason": "breakpoint" if self.break_here(frame) else "step",
            "frames": stack,
        }).encode()
        self._dbg.write(data)
        resp = self._read_response()
        self._dispatch(resp, frame)

debugger = DapBridge()
debugger.consume_initial_config()
_main = open('/main.py').read()
debugger.run(
    compile(_main, '/main.py', 'exec'),
    {'__file__': '/main.py', '__name__': '__main__'}
)

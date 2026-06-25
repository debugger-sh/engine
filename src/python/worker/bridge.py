import bdb, json

CONTINUE   = 0
STEP_OVER  = 1
STEP_INTO  = 2
STEP_OUT   = 3
EXPAND     = 4

# Must fit in the SAB response region (4096 - 12 header bytes).
MAX_RESPONSE_BYTES = 4084
MAX_REPR = 120
MAX_CHILDREN = 50

def truncate_repr(value):
    s = repr(value)
    if len(s) <= MAX_REPR:
        return s
    return s[:MAX_REPR - 1] + '…'

class DapBridge(bdb.Bdb):
    def __init__(self):
        super().__init__()
        self._dbg = open('/__debug__', 'r+b', buffering=0)
        self._stepping = False
        self._refs = {}
        self._next_ref = 1

    def _clear_refs(self):
        self._refs = {}
        self._next_ref = 1

    def _store_ref(self, value):
        ref = self._next_ref
        self._next_ref += 1
        self._refs[ref] = value
        return ref

    def format_local(self, name, value):
        if isinstance(value, list):
            return {
                "name": name,
                "value": f"list[{len(value)}]",
                "objectRef": self._store_ref(value),
            }
        if isinstance(value, tuple):
            return {
                "name": name,
                "value": f"tuple[{len(value)}]",
                "objectRef": self._store_ref(value),
            }
        if isinstance(value, dict):
            return {
                "name": name,
                "value": f"dict[{len(value)}]",
                "objectRef": self._store_ref(value),
            }
        try:
            n = len(vars(value))
        except TypeError:
            n = None
        if n is not None:
            cls = type(value).__name__
            return {
                "name": name,
                "value": f"{cls}[{n}]",
                "objectRef": self._store_ref(value),
            }
        return {"name": name, "value": truncate_repr(value)}

    def _mapping_children(self, mapping):
        children = []
        n = len(mapping)
        for i, (key, item) in enumerate(mapping.items()):
            if i >= MAX_CHILDREN:
                children.append({"name": "…", "value": f"{n - MAX_CHILDREN} more"})
                break
            key_name = key if isinstance(key, str) else repr(key)
            children.append(self.format_local(key_name, item))
        return children

    def _expand_children(self, ref_id):
        value = self._refs.get(ref_id)
        if value is None:
            return {"variables": [], "error": "stale object reference"}

        if isinstance(value, (list, tuple)):
            children = []
            n = len(value)
            for i, item in enumerate(value[:MAX_CHILDREN]):
                children.append(self.format_local(f'[{i}]', item))
            if n > MAX_CHILDREN:
                children.append({"name": "…", "value": f"{n - MAX_CHILDREN} more"})
        elif isinstance(value, dict):
            children = self._mapping_children(value)
        else:
            try:
                children = self._mapping_children(vars(value))
            except TypeError:
                children = []
        return {"variables": children}

    def _write_expand_response(self, body):
        data = json.dumps(body, separators=(',', ':')).encode()
        if len(data) > MAX_RESPONSE_BYTES:
            return self._write_expand_response({
                "variables": [],
                "error": (
                    f"expand response too large ({len(data)} bytes, "
                    f"max {MAX_RESPONSE_BYTES})"
                ),
            })
        self._dbg.write(data)

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
        if resp.get("cmd") != EXPAND:
            self._clear_refs()
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
        self._clear_refs()
        stack = []
        f = frame
        while f is not None:
            name = f.f_code.co_name
            path = f.f_code.co_filename
            if name == '<module>' and path == '/main.py':
                display = '__main__'
            else:
                display = name
            stack.append({
                "file": path,
                "line": f.f_lineno,
                "function": display,
                "user": f.f_code.co_filename == '/main.py',
                "locals": [
                    self.format_local(n, v)
                    for n, v in f.f_locals.items()
                ],
            })
            f = f.f_back

        pause = json.dumps({
            "reason": "breakpoint" if self.break_here(frame) else "step",
            "frames": stack,
        }, separators=(',', ':')).encode()
        self._dbg.write(pause)

        while True:
            resp = self._read_response()
            if resp is None:
                raise RuntimeError("debugger channel closed while paused")
            if resp.get("cmd") == EXPAND:
                self._write_expand_response(self._expand_children(resp.get("ref")))
                continue
            self._dispatch(resp, frame)
            break

debugger = DapBridge()
debugger.consume_initial_config()
_main = open('/main.py').read()
debugger.run(
    compile(_main, '/main.py', 'exec'),
    {'__file__': '/main.py', '__name__': '__main__'}
)

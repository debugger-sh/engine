import bdb, sys, json, os

CONTINUE   = 0
STEP_OVER  = 1
STEP_INTO  = 2
STEP_OUT   = 3

class DapBridge(bdb.Bdb):
    def __init__(self):
        super().__init__()
        self._dbg = open('/__debug__', 'r+b', buffering=0)

    def _read_response(self):
        data = b''
        while True:
            chunk = self._dbg.read(512)
            if not chunk:
                break
            data += chunk
        return json.loads(data.decode())

    def _apply_breakpoints(self, breakpoints):
        self.clear_all_breaks()
        for path, lines in breakpoints.items():
            for line in lines:
                self.set_break(path, line)

    def user_line(self, frame):
        stack = []
        f = frame
        while f is not None:
            stack.append({
                "file": f.f_code.co_filename,
                "line": f.f_lineno,
                "function": f.f_code.co_name,
                "locals": {k: repr(v) for k, v in f.f_locals.items()}
            })
            f = f.f_back

        data = json.dumps({
            "reason": "breakpoint" if self.break_here(frame) else "step",
            "frames": stack,
        }).encode()
        self._dbg.write(data)
        resp = self._read_response()
        self._apply_breakpoints(resp.get("breakpoints", {}))
        cmd = resp["cmd"]

        if cmd == CONTINUE:   self.set_continue()
        elif cmd == STEP_OVER:  self.set_next(frame)
        elif cmd == STEP_INTO:  self.set_step()
        elif cmd == STEP_OUT:   self.set_return(frame)

    def user_exception(self, frame, exc_info):
        self.user_line(frame)

debugger = DapBridge()
_main = open('/main.py').read()
debugger.run(
    compile(_main, '/main.py', 'exec'),
    {'__file__': '/main.py', '__name__': '__main__'}
)

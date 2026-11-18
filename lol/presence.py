from collections import defaultdict
from threading import RLock

_lock = RLock()
_sockets_by_user = defaultdict(set)
_user_by_socket = {}


def connect_socket(socket_id, user_id):
    with _lock:
        was_online = bool(_sockets_by_user[user_id])
        _sockets_by_user[user_id].add(socket_id)
        _user_by_socket[socket_id] = user_id
        return not was_online


def disconnect_socket(socket_id):
    with _lock:
        user_id = _user_by_socket.pop(socket_id, None)
        if user_id is None:
            return None, False
        sockets = _sockets_by_user[user_id]
        sockets.discard(socket_id)
        went_offline = not sockets
        if went_offline:
            _sockets_by_user.pop(user_id, None)
        return user_id, went_offline


def is_online(user_id):
    with _lock:
        return bool(_sockets_by_user.get(user_id))

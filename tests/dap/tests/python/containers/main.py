class User:
    def __init__(self, name, scores):
        self.name = name
        self.scores = scores


def main():
    data = {"users": [{"id": 1, "name": "alice"}, {"id": 2, "name": "bob"}]}
    items = [10, 20, 30]
    carol = User("carol", [100, 92])
    x = 1
    return x


if __name__ == "__main__":
    main()

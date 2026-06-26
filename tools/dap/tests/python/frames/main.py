def level3(c):
    return c


def level2(b):
    return level3(b + 1)


def level1(a):
    return level2(a + 1)


def main():
    return level1(1) - 3


if __name__ == "__main__":
    main()

from typing import Protocol


class Greeter(Protocol):
    def greet(self, name: str) -> str: ...


class EnglishGreeter:
    def greet(self, name: str) -> str:
        return f"Hello, {name}!"


class SpanishGreeter:
    def greet(self, name: str) -> str:
        return f"Hola, {name}!"


def say_hello(greeter: Greeter, name: str) -> str:
    return greeter.greet(name)

from abc import ABC, abstractmethod


class Greeter(ABC):
    @abstractmethod
    def greet(self, name: str) -> str: ...


class EnglishGreeter(Greeter):
    def greet(self, name: str) -> str:
        return f"Hello, {name}!"


class SpanishGreeter(Greeter):
    def greet(self, name: str) -> str:
        return f"Hola, {name}!"


def say_hello(greeter: Greeter, name: str) -> str:
    return greeter.greet(name)


# Unannotated code for inlay hint testing
def add(x, y):
    return x + y


def multiply(x: int, y: int):
    return x * y


result = add(1, 2)
product = multiply(3, 4)

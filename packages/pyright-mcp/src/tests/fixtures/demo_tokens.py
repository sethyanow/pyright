import os
from enum import Enum
from typing import Generic, TypeVar

T = TypeVar("T")

def my_decorator(func):
    return func

class Container(Generic[T]):
    value: T

    @my_decorator
    def get(self) -> T:
        result = self.value
        return result

class Color(Enum):
    RED = 1
    GREEN = 2

def process(container: Container[int]) -> int:
    path = os.path.join("a", "b")
    return container.get()

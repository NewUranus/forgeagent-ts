"""Independent exercise tests; not the official benchmark verifier."""
import keyword
import unittest

from collection_name import is_valid_collection_name


class CollectionNameTests(unittest.TestCase):
    def test_valid_identifiers(self):
        for name in ["my_namespace.my_collection", "ns.collection2", "_ns._name", "名字.集合"]:
            with self.subTest(name=name):
                self.assertIs(is_valid_collection_name(name), True)

    def test_keywords_in_namespace(self):
        for word in keyword.kwlist:
            with self.subTest(word=word):
                self.assertIs(is_valid_collection_name(f"{word}.collection"), False)

    def test_keywords_in_collection(self):
        for word in keyword.kwlist:
            with self.subTest(word=word):
                self.assertIs(is_valid_collection_name(f"ns.{word}"), False)

    def test_invalid_structure_and_identifiers(self):
        for name in ["", "ns", "ns.name.extra", ".name", "ns.", "123name.collection", "ns.1name", "ns.hyphen-name", " ns.name", "ns.name ", "ns.a b"]:
            with self.subTest(name=name):
                self.assertIs(is_valid_collection_name(name), False)

    def test_non_strings(self):
        for value in [None, 1, [], {}, True]:
            with self.subTest(value=value):
                self.assertIs(is_valid_collection_name(value), False)

    def test_keyword_substrings_are_allowed(self):
        for name in ["define.return_value", "Import.CLASS", "ns.true"]:
            with self.subTest(name=name):
                self.assertIs(is_valid_collection_name(name), True)


if __name__ == "__main__":
    unittest.main()

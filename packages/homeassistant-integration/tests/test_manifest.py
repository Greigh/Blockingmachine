"""Test manifest.json and hacs.json compliance."""
import json
import os
import unittest

class TestManifestCompliance(unittest.TestCase):
    def setUp(self):
        self.base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.manifest_path = os.path.join(
            self.base_dir, "custom_components", "blockingmachine", "manifest.json"
        )
        self.hacs_path = os.path.join(
            self.base_dir, "custom_components", "blockingmachine", "hacs.json"
        )

    def test_manifest_structure(self):
        self.assertTrue(os.path.exists(self.manifest_path), "manifest.json must exist")
        with open(self.manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data.get("domain"), "blockingmachine")
        self.assertEqual(data.get("name"), "Blockingmachine")
        self.assertTrue(data.get("config_flow"), "config_flow must be True")
        self.assertIn("@greigh", data.get("codeowners", []))
        self.assertEqual(data.get("integration_type"), "hub")
        self.assertEqual(data.get("iot_class"), "local_polling")

    def test_hacs_structure(self):
        self.assertTrue(os.path.exists(self.hacs_path), "hacs.json must exist")
        with open(self.hacs_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data.get("name"), "Blockingmachine")
        self.assertTrue(data.get("render_readme"))
        self.assertIn("homeassistant", data)

if __name__ == "__main__":
    unittest.main()

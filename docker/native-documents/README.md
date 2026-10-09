# Native document runtime

The sandbox image includes public libraries for DOCX, XLSX, PPTX, and PDF files.
The runtime requires no package downloads during a session.
The helper and tests in this directory are original project code.

Use `/opt/valet-office/bin/python` for document scripts.
Use `/opt/valet-office/office.py check` with that interpreter to check installed tools.
The `inspect PATH` and `validate PATH` commands return JSON and never save the input.
Both commands check readability. Office files also receive ZIP integrity and XML syntax checks.
These checks do not prove schema compliance, content preservation, formula correctness, or visual fidelity.
Inspection supports `.docx`, `.xlsx`, `.pptx`, and unencrypted `.pdf` files.
Macro-enabled and legacy Office formats require a separate workflow.

LibreOffice provides headless rendering and spreadsheet recalculation.
Poppler provides `pdfinfo`, `pdftotext`, and `pdftoppm`.
Liberation, DejaVu, and Noto fonts provide common font coverage.
Font substitution can change layout.
Use a separate temporary LibreOffice user profile for each conversion process.

Always edit a copy. Change the smallest supported object or XML part.
Reopen the result. Compare required content and render the affected pages.
Library save operations can remove unsupported features.
Openpyxl does not calculate formulas and can remove unsupported workbook objects.
PDF text replacement, signatures, macros, tracked changes, embedded objects, and complex layouts require additional checks or specialized tools.

## Validation

Run the Python file tests with the pinned environment:

```sh
/opt/valet-office/bin/python /opt/valet-office-src/test_office.py
```

The tests create each file format, make an edit, save it, and reopen it.
They assert specific retained features, such as styles, formulas, headers, notes, and PDF text.
They also assert that inspection leaves source bytes unchanged.
These fixtures do not establish preservation for arbitrary documents.
When render tools are present, tests convert Office fixtures to PDF and rasterize one page.
Rasterization proves that the render path works. A person or agent must still inspect the rendered layout.
The image build runs these tests and checks that all render tools exist.

Build only this runtime from the repository root:

```sh
docker build --target office-runtime -f docker/Dockerfile.sandbox-k8s -t valet-office:test .
```

## Dependency sources and licenses

`requirements.txt` pins direct and transitive Python dependencies with published wheel hashes.
The `update-lock.py` script refreshes hashes without changing versions.
It includes Debian Python 3.11 wheels for amd64 and arm64, plus macOS Python 3.14 wheels for local tests.
Builds install wheels only. Installed distributions retain their bundled license files.
Versions and license metadata were checked against each release's public PyPI metadata.

| Package | Version | License | Source |
| --- | --- | --- | --- |
| python-docx | 1.2.0 | MIT | https://pypi.org/project/python-docx/1.2.0/ |
| openpyxl | 3.1.5 | MIT | https://pypi.org/project/openpyxl/3.1.5/ |
| python-pptx | 1.0.2 | MIT | https://pypi.org/project/python-pptx/1.0.2/ |
| pypdf | 6.19.0 | BSD-3-Clause | https://pypi.org/project/pypdf/6.19.0/ |
| reportlab | 5.0.1 | BSD | https://pypi.org/project/reportlab/5.0.1/ |
| lxml | 6.1.3 | BSD-3-Clause; bundled library notices | https://pypi.org/project/lxml/6.1.3/ |
| Pillow | 12.3.0 | MIT-CMU; bundled library notices | https://pypi.org/project/pillow/12.3.0/ |
| typing-extensions | 4.16.0 | PSF-2.0 | https://pypi.org/project/typing-extensions/4.16.0/ |
| et-xmlfile | 2.0.0 | MIT | https://pypi.org/project/et-xmlfile/2.0.0/ |
| XlsxWriter | 3.2.9 | BSD-2-Clause | https://pypi.org/project/xlsxwriter/3.2.9/ |
| charset-normalizer | 3.5.2 | MIT | https://pypi.org/project/charset-normalizer/3.5.2/ |
| defusedxml | 0.7.1 | PSF | https://pypi.org/project/defusedxml/0.7.1/ |

Debian packages retain notices under `/usr/share/doc/<package>/copyright`.
LibreOffice uses MPL-2.0 and other licenses for bundled components.
Poppler uses GPL-2.0-or-later and associated component licenses.
The fonts use their upstream free font licenses.
Debian installs the compatible distribution versions; these packages are not version-pinned here.
The package notices identify applicable source and license obligations when distributing an image.
See [LibreOffice licensing](https://www.libreoffice.org/about-us/licenses/) and [Debian package sources](https://sources.debian.org/).

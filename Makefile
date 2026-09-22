.PHONY: test lint run

test:
	PYTHONPATH=src python -m unittest discover -s tests -v

lint:
	ruff check .

run:
	PYTHONPATH=src python -m qq_group_ops

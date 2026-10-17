CC = clang
ifndef BUILD_DIR
$(error BUILD_DIR must name an absolute new owned output directory)
endif
ifneq ($(filter /%,$(BUILD_DIR)),$(BUILD_DIR))
$(error BUILD_DIR must be absolute)
endif
CFLAGS = -std=c11 -Wall -Wextra -Werror -Wconversion -Wshadow -Wstrict-prototypes -Wformat=2 -pedantic -pthread -O2
SOURCES = core/policy_v1.c core/io_budget_v1.c tests/io_budget_test_v1.c
.PHONY: test
test: $(BUILD_DIR)/io_budget_test_v1
	"$(BUILD_DIR)/io_budget_test_v1"
$(BUILD_DIR)/io_budget_test_v1: $(SOURCES) core/policy_v1.h core/io_budget_v1.h
	mkdir -p "$(BUILD_DIR)"
	$(CC) $(CFLAGS) $(SOURCES) -o "$@"

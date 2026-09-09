import {
  Customer,
  CustomerAddress,
  CustomerGroup,
  CustomerGroupCustomer,
} from '@medusajs/customer/dist/models';

/**
 * Test support (NOT under __tests__: the integration:modules tier globs every
 * file there as a suite). The core Customer module's DML models, for
 * `moduleIntegrationTestRunner`
 * specs whose code path reads the customer-group tables with raw SQL
 * (PacksModuleService.partnerGroupOfCustomers — partner groups, spec
 * 2026-09-09). The module runner only creates the tables of the models it is
 * handed, so without these `customer_group_customer` does not exist and every
 * partner-rate read throws TableNotFoundException. Spread into
 * `moduleModels` alongside the packs models; all four travel together because
 * they reference each other.
 */
export const CORE_CUSTOMER_MODELS = [
  Customer,
  CustomerAddress,
  CustomerGroup,
  CustomerGroupCustomer,
];
